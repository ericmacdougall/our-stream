// SPDX-License-Identifier: AGPL-3.0-only
// Streams, stream grants, members and invites. Grants go through writeTuple only (ADR-0002).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeTuple, type Tuple } from '@our-stream/authz';
import {
  CreateStreamRequest,
  GrantStreamRoleRequest,
  InviteRequest,
  MemberList,
  type MemberSummary,
  Ok,
  type Stream,
  StreamList,
  StreamM1b,
  StreamMemberList,
  Uuid,
} from '@our-stream/contracts';
import { withTenant } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { ADMIN_ROLES, requireMember, requireRole } from '../lib/auth.js';
import { displayNameFromEmail, normalizeEmail } from '../lib/email.js';
import { conflict, fromAuthzError, notFound } from '../lib/errors.js';
import { magicLinkMail } from '../lib/mailer.js';
import { accountByEmail, accountCreate, magicLinkCreate } from '../lib/platform.js';
import { newSessionToken, sha256 } from '../lib/tokens.js';

const security = [{ cookieAuth: [] }, { bearerAuth: [] }];

type StreamRow = {
  id: string;
  kind: z.infer<typeof Stream>['kind'];
  slug: string;
  name: string;
  my_role: z.infer<typeof Stream>['myRole'];
  comments_enabled: boolean;
};

export function registerOrgRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/streams',
    { schema: { tags: ['org'], response: { 200: StreamList }, security } },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        // Private streams are listed only to members who hold a role on them.
        const r = await client.query<StreamRow>(
          `SELECT s.id, s.kind, s.slug, s.name, usa.role AS my_role,
                  COALESCE((s.settings -> 'comments' ->> 'enabled') IS DISTINCT FROM 'false', true) AS comments_enabled
           FROM stream s LEFT JOIN user_stream_access usa
             ON usa.org_id = s.org_id AND usa.stream_id = s.id AND usa.user_id = $2
           WHERE s.org_id = $1 AND (s.kind <> 'private' OR usa.role IS NOT NULL)
           ORDER BY s.kind, s.name`,
          [auth.orgId, auth.userId],
        );
        // Lists are enveloped as the frozen contract declares them (GoodQA #35633).
        return {
          items: r.rows.map((s) => ({
            id: s.id,
            kind: s.kind,
            slug: s.slug,
            name: s.name,
            myRole: s.my_role,
            commentsEnabled: s.comments_enabled,
          })),
        };
      });
    },
  );

  app.get(
    '/v1/streams/:id',
    {
      schema: {
        tags: ['org'],
        params: z.object({ id: Uuid }),
        response: { 200: StreamM1b },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        // Same visibility as the list: a private stream exists only for members holding a role on it.
        const r = await client.query<StreamRow>(
          `SELECT s.id, s.kind, s.slug, s.name, usa.role AS my_role,
                  COALESCE((s.settings -> 'comments' ->> 'enabled') IS DISTINCT FROM 'false', true) AS comments_enabled
           FROM stream s LEFT JOIN user_stream_access usa
             ON usa.org_id = s.org_id AND usa.stream_id = s.id AND usa.user_id = $2
           WHERE s.org_id = $1 AND s.id = $3 AND (s.kind <> 'private' OR usa.role IS NOT NULL)`,
          [auth.orgId, auth.userId, req.params.id],
        );
        const row = r.rows[0];
        if (!row) throw notFound('stream_not_found', 'stream not found');
        return {
          id: row.id,
          kind: row.kind,
          slug: row.slug,
          name: row.name,
          myRole: row.my_role,
          commentsEnabled: row.comments_enabled,
        };
      });
    },
  );

  app.get(
    '/v1/streams/:id/members',
    {
      schema: {
        tags: ['org'],
        params: z.object({ id: Uuid }),
        response: { 200: StreamMemberList },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        // Same visibility as the stream list: a private stream exists only for members holding a role on it.
        const visible = await client.query(
          `SELECT 1 FROM stream s LEFT JOIN user_stream_access usa
             ON usa.org_id = s.org_id AND usa.stream_id = s.id AND usa.user_id = $2
           WHERE s.org_id = $1 AND s.id = $3 AND (s.kind <> 'private' OR usa.role IS NOT NULL)`,
          [auth.orgId, auth.userId, req.params.id],
        );
        if ((visible.rowCount ?? 0) === 0) throw notFound('stream_not_found', 'stream not found');
        // Effective members: the derived access table already holds each member's highest role,
        // including access through groups and the everyone grant (ADR-0002 materialisation).
        const r = await client.query<{
          user_id: string;
          display_name: string | null;
          role: z.infer<typeof StreamMemberList>['items'][number]['role'];
        }>(
          `SELECT usa.user_id, a.display_name, usa.role
           FROM user_stream_access usa
           JOIN org_membership m ON m.org_id = usa.org_id AND m.user_id = usa.user_id AND m.status = 'active'
           LEFT JOIN LATERAL platform_account_get(usa.user_id) a ON true
           WHERE usa.org_id = $1 AND usa.stream_id = $2
           ORDER BY CASE usa.role WHEN 'owner' THEN 4 WHEN 'moderator' THEN 3 WHEN 'contributor' THEN 2 ELSE 1 END DESC,
                    a.display_name, usa.user_id
           LIMIT 500`,
          [auth.orgId, req.params.id],
        );
        return {
          items: r.rows.map((m) => ({
            userId: m.user_id,
            displayName: m.display_name ?? 'unknown',
            role: m.role,
          })),
        };
      });
    },
  );

  app.post(
    '/v1/streams',
    {
      schema: { tags: ['org'], body: CreateStreamRequest, response: { 200: StreamM1b }, security },
    },
    async (req) => {
      // M1a: stream creation is an org owner/admin action; the creator becomes the stream owner.
      const auth = requireRole(req, ADMIN_ROLES);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        let id: string;
        try {
          const r = await client.query<{ id: string }>(
            'INSERT INTO stream (org_id, kind, slug, name) VALUES ($1, $2, $3, $4) RETURNING id',
            [auth.orgId, req.body.kind, req.body.slug, req.body.name],
          );
          id = r.rows[0]!.id;
        } catch (err) {
          if ((err as { code?: string }).code === '23505')
            throw conflict('slug_taken', 'a stream with this slug exists');
          throw err;
        }
        try {
          await writeTuple(client, {
            objectType: 'stream',
            objectId: id,
            relation: 'owner',
            subjectType: 'user',
            subjectId: auth.userId,
            subjectRelation: '',
          });
        } catch (err) {
          throw fromAuthzError(err);
        }
        return {
          id,
          kind: req.body.kind,
          slug: req.body.slug,
          name: req.body.name,
          myRole: 'owner' as const,
          commentsEnabled: true,
        };
      });
    },
  );

  app.post(
    '/v1/streams/:id/grants',
    {
      schema: {
        tags: ['org'],
        params: z.object({ id: Uuid }),
        body: GrantStreamRoleRequest,
        response: { 200: Ok },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      const s = req.body.subject;
      const tuple: Tuple = {
        objectType: 'stream',
        objectId: req.params.id,
        relation: req.body.role,
        subjectType: s.type === 'everyone' ? 'org' : s.type,
        subjectId: s.type === 'everyone' ? auth.orgId : s.type === 'user' ? s.userId : s.groupId,
        subjectRelation: s.type === 'everyone' ? 'member' : '',
      };
      await withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        try {
          await writeTuple(client, tuple);
        } catch (err) {
          throw fromAuthzError(err);
        }
      });
      return { ok: true as const };
    },
  );

  app.get(
    '/v1/members',
    { schema: { tags: ['org'], response: { 200: MemberList }, security } },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const r = await client.query<{
          user_id: string;
          role: z.infer<typeof MemberSummary>['role'];
          status: z.infer<typeof MemberSummary>['status'];
          email: string;
          display_name: string;
        }>(
          `SELECT m.user_id, m.role, m.status, a.email, a.display_name
           FROM org_membership m JOIN LATERAL platform_account_get(m.user_id) a ON true
           WHERE m.org_id = $1 ORDER BY a.display_name, m.user_id`,
          [auth.orgId],
        );
        return {
          items: r.rows.map((m) => ({
            userId: m.user_id,
            displayName: m.display_name,
            email: m.email,
            role: m.role,
            status: m.status,
          })),
        };
      });
    },
  );

  app.post(
    '/v1/invites',
    { schema: { tags: ['org'], body: InviteRequest, response: { 200: Ok }, security } },
    async (req) => {
      const auth = requireRole(req, ADMIN_ROLES);
      const email = req.body.email.trim();
      const emailNormalized = normalizeEmail(email);
      // The invited address gets an account (no password) so the magic link has a subject; it joins the
      // org only when the link is consumed (platform_invite_accept).
      let account = await accountByEmail(ctx.pool, emailNormalized);
      if (!account) {
        try {
          const id = await accountCreate(
            ctx.pool,
            email,
            emailNormalized,
            displayNameFromEmail(email),
            null,
          );
          account = { id, email, displayName: displayNameFromEmail(email), passwordHash: null };
        } catch (err) {
          if ((err as { code?: string }).code !== '23505') throw err;
          account = await accountByEmail(ctx.pool, emailNormalized);
          if (!account) throw err;
        }
      }
      const userId = account.id;
      const orgName = await withTenant(
        ctx.pool,
        { orgId: auth.orgId, userId: auth.userId },
        async (client) => {
          const active = await client.query(
            `SELECT 1 FROM org_membership WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
            [auth.orgId, userId],
          );
          if ((active.rowCount ?? 0) > 0)
            throw conflict('already_member', 'this person is already an active member');
          await client.query(
            `INSERT INTO invite (org_id, email_normalized, role, invited_by, expires_at)
             VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int))
             ON CONFLICT (org_id, email_normalized) DO UPDATE
               SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, accepted_at = NULL, expires_at = EXCLUDED.expires_at`,
            [
              auth.orgId,
              emailNormalized,
              req.body.role,
              auth.userId,
              ctx.config.INVITE_LINK_TTL_DAYS,
            ],
          );
          const org = await client.query<{ name: string }>('SELECT name FROM org WHERE id = $1', [
            auth.orgId,
          ]);
          return org.rows[0]?.name ?? 'our-stream';
        },
      );
      const token = newSessionToken();
      await magicLinkCreate(
        ctx.pool,
        userId,
        sha256(token),
        'invite',
        auth.orgId,
        ctx.config.INVITE_LINK_TTL_DAYS * 24 * 60,
      );
      const link = `${ctx.config.APP_BASE_URL}/magic?token=${encodeURIComponent(token)}`;
      await ctx.mailer.send(magicLinkMail(account.email, link, 'invite', orgName));
      return { ok: true as const };
    },
  );
}
