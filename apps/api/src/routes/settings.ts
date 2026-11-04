// SPDX-License-Identifier: AGPL-3.0-only
// Org and stream settings, event tags, pins and notification preferences. Settings are merged into
// jsonb key by key and audited; tags are the closed EventTag enum (checked by the database too); pins
// never change visibility, only decorate and filter the feed for viewers who already pass readerVisible.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ContentDetailM1b,
  MePreferences,
  OrgSettings,
  PinQuery,
  PinRequest,
  SetTagsRequest,
  StreamM1b,
  UpdateMePreferencesRequest,
  UpdateOrgSettingsRequest,
  UpdateStreamRequest,
  Uuid,
} from '@our-stream/contracts';
import { withTenant, type TenantClient } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { ADMIN_ROLES, requireMember, requireRole } from '../lib/auth.js';
import { loadContent, requireAuthor } from '../lib/content.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { audit, requireBudget } from '../lib/m1b-sql.js';
import { readOrgSettings, writeOrgSettings } from '../lib/settings.js';

const security = [{ cookieAuth: [] }, { bearerAuth: [] }];
const Params = z.object({ id: Uuid });
const PIN_ROLES = ['owner', 'admin', 'announcer'] as const;

export function registerSettingsRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/org/settings',
    { schema: { tags: ['org'], response: { 200: OrgSettings }, security } },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, (client) =>
        readOrgSettings(client),
      );
    },
  );

  app.patch(
    '/v1/org/settings',
    {
      schema: {
        tags: ['org'],
        body: UpdateOrgSettingsRequest,
        response: { 200: OrgSettings },
        security,
      },
    },
    async (req) => {
      const auth = requireRole(req, ADMIN_ROLES);
      requireBudget(ctx.limits.write, auth.sessionId);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const current = await readOrgSettings(client, true);
        const patch = Object.fromEntries(
          Object.entries(req.body).filter(([, v]) => v !== undefined),
        ) as Partial<typeof current>;
        const next = { ...current, ...patch };
        await writeOrgSettings(client, next);
        await audit(client, 'org.settings_updated', { changed: Object.keys(patch) });
        return next;
      });
    },
  );

  app.patch(
    '/v1/streams/:id',
    {
      schema: {
        tags: ['org'],
        params: Params,
        body: UpdateStreamRequest,
        response: { 200: StreamM1b },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.write, auth.sessionId);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const s = await client.query<{
          id: string;
          kind: z.infer<typeof StreamM1b>['kind'];
          slug: string;
          name: string;
          my_role: z.infer<typeof StreamM1b>['myRole'];
        }>(
          `SELECT s.id, s.kind, s.slug, s.name, usa.role AS my_role FROM stream s
           LEFT JOIN user_stream_access usa ON usa.org_id = s.org_id AND usa.stream_id = s.id AND usa.user_id = $2
           WHERE s.org_id = $1 AND s.id = $3 FOR UPDATE OF s`,
          [auth.orgId, auth.userId, req.params.id],
        );
        const stream = s.rows[0];
        if (
          !stream ||
          (stream.kind === 'private' &&
            !stream.my_role &&
            !ADMIN_ROLES.includes(auth.membership.role))
        )
          throw notFound('stream_not_found', 'stream not found');
        if (!ADMIN_ROLES.includes(auth.membership.role) && stream.my_role !== 'owner')
          throw forbidden('role_forbidden', 'requires an org admin or the stream owner');
        if (req.body.commentsEnabled !== undefined) {
          await client.query(
            `UPDATE stream SET settings = settings || jsonb_build_object('comments', jsonb_build_object('enabled', $3::boolean)) WHERE org_id = $1 AND id = $2`,
            [auth.orgId, req.params.id, req.body.commentsEnabled],
          );
          await audit(client, 'stream.settings_updated', {
            streamId: req.params.id,
            commentsEnabled: req.body.commentsEnabled,
          });
        }
        const after = await client.query<{ comments_enabled: boolean }>(
          `SELECT COALESCE((settings -> 'comments' ->> 'enabled') IS DISTINCT FROM 'false', true) AS comments_enabled FROM stream WHERE org_id = $1 AND id = $2`,
          [auth.orgId, req.params.id],
        );
        return {
          id: stream.id,
          kind: stream.kind,
          slug: stream.slug,
          name: stream.name,
          myRole: stream.my_role,
          commentsEnabled: after.rows[0]!.comments_enabled,
        };
      });
    },
  );

  app.put(
    '/v1/content/:id/tags',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: SetTagsRequest,
        response: { 200: ContentDetailM1b },
        security,
      },
    },
    async (req) => {
      // Tags are editorial: owner/admin/announcer authors only (brief); contributors ask an announcer.
      const auth = requireRole(req, PIN_ROLES);
      requireBudget(ctx.limits.write, auth.sessionId);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await requireAuthor(client, req.params.id);
        // content_changed bumps content_epoch when event_tags change (ADR-0004); the CHECK constraint re-validates.
        await client.query(
          `UPDATE content SET event_tags = $3::text[] WHERE org_id = $1 AND id = $2`,
          [auth.orgId, req.params.id, req.body.tags],
        );
        return (await loadContent(client, req.params.id)).detail;
      });
    },
  );

  /** Pin permission: org scope needs owner/admin/announcer; stream scope also accepts that stream's moderator/owner. */
  const requirePinRight = async (
    client: TenantClient,
    role: string,
    contentId: string,
    streamId: string | null,
  ): Promise<void> => {
    const editorial = (PIN_ROLES as readonly string[]).includes(role);
    if (streamId === null) {
      if (!editorial)
        throw forbidden('pin_forbidden', 'org-wide pins need owner, admin or announcer');
      return;
    }
    if (!editorial) {
      const r = await client.query(
        `SELECT 1 FROM user_stream_access WHERE org_id = $1 AND user_id = $2 AND stream_id = $3 AND role IN ('moderator', 'owner')`,
        [client.tenant.orgId, client.tenant.userId, streamId],
      );
      if ((r.rowCount ?? 0) === 0)
        throw forbidden('pin_forbidden', 'stream pins need a moderator or owner of that stream');
    }
    const inAudience = await client.query(
      `SELECT 1 FROM content_audience WHERE org_id = $1 AND content_id = $2 AND kind = 'stream' AND principal_id = $3`,
      [client.tenant.orgId, contentId, streamId],
    );
    if ((inAudience.rowCount ?? 0) === 0)
      throw conflict('not_in_audience', 'the item is not addressed to that stream');
  };

  const bumpEpoch = (client: TenantClient, contentId: string) =>
    client.query(
      `UPDATE content SET content_epoch = content_epoch + 1, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [client.tenant.orgId, contentId],
    );

  app.post(
    '/v1/content/:id/pin',
    {
      schema: {
        tags: ['content'],
        params: Params,
        body: PinRequest,
        response: { 200: ContentDetailM1b },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.write, auth.sessionId);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const loaded = await loadContent(client, req.params.id); // 404 unless visible or author-accessible
        await requirePinRight(client, auth.membership.role, req.params.id, req.body.streamId);
        const d = loaded.detail;
        const live =
          d.state === 'published' &&
          d.publishAt !== null &&
          new Date(d.publishAt).getTime() <= Date.now() &&
          (d.expiresAt === null || new Date(d.expiresAt).getTime() > Date.now());
        if (!live) throw conflict('not_published', 'only live published items can be pinned');
        await client.query(
          `INSERT INTO content_pin (org_id, content_id, scope_kind, scope_id, pinned_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [
            auth.orgId,
            req.params.id,
            req.body.streamId ? 'stream' : 'org',
            req.body.streamId ?? auth.orgId,
            auth.userId,
          ],
        );
        await bumpEpoch(client, req.params.id);
        await audit(client, 'content.pinned', {
          contentId: req.params.id,
          streamId: req.body.streamId,
        });
        return (await loadContent(client, req.params.id)).detail;
      });
    },
  );

  app.delete(
    '/v1/content/:id/pin',
    {
      schema: {
        tags: ['content'],
        params: Params,
        querystring: PinQuery,
        response: { 200: ContentDetailM1b },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.write, auth.sessionId);
      const streamId = req.query.streamId ?? null;
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await loadContent(client, req.params.id);
        const editorial = (PIN_ROLES as readonly string[]).includes(auth.membership.role);
        if (streamId === null) {
          if (!editorial)
            throw forbidden('pin_forbidden', 'org-wide pins need owner, admin or announcer');
        } else if (!editorial) {
          const r = await client.query(
            `SELECT 1 FROM user_stream_access WHERE org_id = $1 AND user_id = $2 AND stream_id = $3 AND role IN ('moderator', 'owner')`,
            [auth.orgId, auth.userId, streamId],
          );
          if ((r.rowCount ?? 0) === 0)
            throw forbidden(
              'pin_forbidden',
              'stream pins need a moderator or owner of that stream',
            );
        }
        await client.query(
          `DELETE FROM content_pin WHERE org_id = $1 AND content_id = $2 AND scope_kind = $3 AND scope_id = $4`,
          [auth.orgId, req.params.id, streamId ? 'stream' : 'org', streamId ?? auth.orgId],
        );
        await bumpEpoch(client, req.params.id);
        await audit(client, 'content.unpinned', { contentId: req.params.id, streamId });
        return (await loadContent(client, req.params.id)).detail;
      });
    },
  );

  app.get(
    '/v1/me/preferences',
    { schema: { tags: ['auth'], response: { 200: MePreferences }, security } },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const r = await client.query<{ email_digest: 'daily' | 'off' }>(
          'SELECT email_digest FROM member_preference WHERE org_id = $1 AND user_id = $2',
          [auth.orgId, auth.userId],
        );
        return { emailDigest: r.rows[0]?.email_digest ?? 'daily' };
      });
    },
  );

  app.patch(
    '/v1/me/preferences',
    {
      schema: {
        tags: ['auth'],
        body: UpdateMePreferencesRequest,
        response: { 200: MePreferences },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.write, auth.sessionId);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        if (req.body.emailDigest) {
          await client.query(
            `INSERT INTO member_preference (org_id, user_id, email_digest) VALUES ($1, $2, $3)
             ON CONFLICT (org_id, user_id) DO UPDATE SET email_digest = EXCLUDED.email_digest, updated_at = now()`,
            [auth.orgId, auth.userId, req.body.emailDigest],
          );
        }
        const r = await client.query<{ email_digest: 'daily' | 'off' }>(
          'SELECT email_digest FROM member_preference WHERE org_id = $1 AND user_id = $2',
          [auth.orgId, auth.userId],
        );
        return { emailDigest: r.rows[0]?.email_digest ?? 'daily' };
      });
    },
  );
}
