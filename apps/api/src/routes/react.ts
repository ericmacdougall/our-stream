// SPDX-License-Identifier: AGPL-3.0-only
// Reactions, comments (threaded, moderated per decision Q7) and share-as-link (ADR-0002: sharing
// never writes tuples). Every route gates on readerVisible first, so draft, scheduled, expired and
// retracted items answer 404 and retraction hides existing threads; the database enforces ownership of
// rows (migration 0007 policies) and performs moderation and reporting in definer functions.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { readerVisibleSql } from '@our-stream/authz';
import {
  Comment,
  CommentList,
  CommentListQuery,
  CreateCommentRequest,
  Ok,
  ReactionResponse,
  RemoveCommentRequest,
  ReportCommentRequest,
  ShareRequest,
  ShareResponse,
  Uuid,
} from '@our-stream/contracts';
import { withTenant, type TenantClient } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { requireMember } from '../lib/auth.js';
import {
  normalizeCommentBody,
  scanComment,
  scanVerdict,
  COMMENT_MAX_UNITS,
} from '../lib/comment-text.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit, commentsEnabledSql, requireBudget, requireVisible } from '../lib/m1b-sql.js';
import { readOrgSettings } from '../lib/settings.js';

const security = [{ cookieAuth: [] }, { bearerAuth: [] }];
const Params = z.object({ id: Uuid });
type CommentDto = z.infer<typeof Comment>;
type CommentCore = CommentDto['replies'][number];

interface CommentRow {
  id: string;
  content_id: string;
  root_id: string | null;
  author_id: string;
  author_name: string | null;
  body: string;
  state: 'visible' | 'removed';
  report_count: number;
  created_at: Date;
  removed_at: Date | null;
}

// created_at is truncated to milliseconds so the keyset cursor (ms precision in JS) compares exactly.
const COMMENT_COLUMNS = `k.id, k.content_id, k.root_id, k.author_id, a.display_name AS author_name, k.body, k.state, k.report_count, date_trunc('milliseconds', k.created_at) AS created_at, k.removed_at`;
const COMMENT_FROM = `FROM comment k LEFT JOIN LATERAL platform_account_get(k.author_id) a ON true`;
const MAX_REPLIES = 50;

function toCore(row: CommentRow, viewer: { userId: string; canModerate: boolean }): CommentCore {
  const removed = row.state === 'removed';
  const core: CommentCore = {
    id: row.id,
    contentId: row.content_id,
    parentId: row.root_id,
    author: removed ? null : { id: row.author_id, displayName: row.author_name ?? 'unknown' },
    body: removed ? null : row.body,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    removedAt: row.removed_at?.toISOString() ?? null,
    canRemove: !removed && (row.author_id === viewer.userId || viewer.canModerate),
  };
  if (viewer.canModerate) core.reportCount = row.report_count;
  return core;
}

async function canModerate(client: TenantClient, contentId: string): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>('SELECT comment_can_moderate($1, $2, $3) AS ok', [
    client.tenant.orgId,
    client.tenant.userId,
    contentId,
  ]);
  return r.rows[0]?.ok === true;
}

async function commentsEnabled(client: TenantClient, contentId: string): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>(
    `SELECT ${commentsEnabledSql('c')} AS ok FROM content c WHERE c.org_id = $1 AND c.id = $2`,
    [client.tenant.orgId, contentId],
  );
  return r.rows[0]?.ok === true;
}

async function loadComment(client: TenantClient, id: string): Promise<CommentRow> {
  const r = await client.query<CommentRow>(
    `SELECT ${COMMENT_COLUMNS} ${COMMENT_FROM} WHERE k.org_id = $1 AND k.id = $2`,
    [client.tenant.orgId, id],
  );
  const row = r.rows[0];
  if (!row) throw notFound('comment_not_found', 'comment not found');
  return row;
}

/** A comment is addressable only while its item is reader-visible to the caller (same 404 as a missing one). */
async function loadVisibleComment(client: TenantClient, id: string): Promise<CommentRow> {
  const row = await loadComment(client, id);
  try {
    await requireVisible(client, row.content_id);
  } catch {
    throw notFound('comment_not_found', 'comment not found');
  }
  return row;
}

async function fullComment(
  client: TenantClient,
  row: CommentRow,
  userId: string,
): Promise<CommentDto> {
  const mod = await canModerate(client, row.content_id);
  const viewer = { userId, canModerate: mod };
  const core = toCore(row, viewer);
  if (row.root_id) return { ...core, replies: [], replyCount: 0 };
  const replies = await client.query<CommentRow>(
    `SELECT ${COMMENT_COLUMNS} ${COMMENT_FROM} WHERE k.org_id = $1 AND k.root_id = $2 ORDER BY k.created_at, k.id LIMIT ${MAX_REPLIES}`,
    [client.tenant.orgId, row.id],
  );
  const count = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM comment WHERE org_id = $1 AND root_id = $2',
    [client.tenant.orgId, row.id],
  );
  return {
    ...core,
    replies: replies.rows.map((r) => toCore(r, viewer)),
    replyCount: count.rows[0]?.n ?? 0,
  };
}

export function registerReactRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const reactionState = async (client: TenantClient, contentId: string) => {
    const r = await client.query<{ like_count: number; liked: boolean }>(
      `SELECT (SELECT count(*)::int FROM reaction r WHERE r.org_id = $1 AND r.content_id = $2) AS like_count,
              EXISTS (SELECT 1 FROM reaction r WHERE r.org_id = $1 AND r.content_id = $2 AND r.user_id = $3) AS liked`,
      [client.tenant.orgId, contentId, client.tenant.userId],
    );
    return { liked: r.rows[0]!.liked, likeCount: r.rows[0]!.like_count };
  };

  app.post(
    '/v1/content/:id/like',
    {
      schema: {
        tags: ['reactions'],
        params: Params,
        response: { 200: ReactionResponse },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.write, auth.sessionId);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await requireVisible(client, req.params.id);
        await client.query(
          `INSERT INTO reaction (org_id, content_id, user_id, kind) VALUES ($1, $2, $3, 'like') ON CONFLICT DO NOTHING`,
          [auth.orgId, req.params.id, auth.userId],
        );
        return reactionState(client, req.params.id);
      });
    },
  );

  app.delete(
    '/v1/content/:id/like',
    {
      schema: {
        tags: ['reactions'],
        params: Params,
        response: { 200: ReactionResponse },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.write, auth.sessionId);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await requireVisible(client, req.params.id);
        await client.query(
          `DELETE FROM reaction WHERE org_id = $1 AND content_id = $2 AND user_id = $3 AND kind = 'like'`,
          [auth.orgId, req.params.id, auth.userId],
        );
        return reactionState(client, req.params.id);
      });
    },
  );

  app.get(
    '/v1/content/:id/comments',
    {
      schema: {
        tags: ['comments'],
        params: Params,
        querystring: CommentListQuery,
        response: { 200: CommentList },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : null;
      if (req.query.cursor && !cursor) throw badRequest('bad_cursor', 'invalid cursor');
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await requireVisible(client, req.params.id);
        const mod = await canModerate(client, req.params.id);
        const viewer = { userId: auth.userId, canModerate: mod };
        const roots = await client.query<CommentRow & { reply_count: number }>(
          `SELECT ${COMMENT_COLUMNS}, (SELECT count(*)::int FROM comment r WHERE r.org_id = k.org_id AND r.root_id = k.id) AS reply_count
           ${COMMENT_FROM}
           WHERE k.org_id = $1 AND k.content_id = $2 AND k.root_id IS NULL
             AND ($3::timestamptz IS NULL OR (date_trunc('milliseconds', k.created_at), k.id) > ($3::timestamptz, $4::uuid))
           ORDER BY date_trunc('milliseconds', k.created_at), k.id LIMIT $5`,
          [
            auth.orgId,
            req.params.id,
            cursor?.publishAt ?? null,
            cursor?.id ?? null,
            req.query.limit + 1,
          ],
        );
        const page = roots.rows.slice(0, req.query.limit);
        const replies = page.length
          ? await client.query<CommentRow & { rn: number }>(
              `SELECT * FROM (
                 SELECT ${COMMENT_COLUMNS}, row_number() OVER (PARTITION BY k.root_id ORDER BY k.created_at, k.id) AS rn
                 ${COMMENT_FROM} WHERE k.org_id = $1 AND k.root_id = ANY($2::uuid[])) x
               WHERE rn <= ${MAX_REPLIES} ORDER BY created_at, id`,
              [auth.orgId, page.map((r) => r.id)],
            )
          : { rows: [] as Array<CommentRow & { rn: number }> };
        const byRoot = new Map<string, CommentCore[]>();
        for (const r of replies.rows) {
          const list = byRoot.get(r.root_id!) ?? [];
          list.push(toCore(r, viewer));
          byRoot.set(r.root_id!, list);
        }
        const last = page[page.length - 1];
        return {
          items: page.map((r) => ({
            ...toCore(r, viewer),
            replies: byRoot.get(r.id) ?? [],
            replyCount: r.reply_count,
          })),
          nextCursor:
            roots.rows.length > req.query.limit && last
              ? encodeCursor(last.created_at, last.id)
              : null,
          commentsEnabled: await commentsEnabled(client, req.params.id),
          canModerate: mod,
        };
      });
    },
  );

  app.post(
    '/v1/content/:id/comments',
    {
      schema: {
        tags: ['comments'],
        params: Params,
        body: CreateCommentRequest,
        response: { 200: Comment },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.comment, auth.sessionId);
      const body = normalizeCommentBody(req.body.body);
      if (body.length === 0) throw badRequest('empty_body', 'comment is empty');
      if (body.length > COMMENT_MAX_UNITS) throw badRequest('body_too_long', 'comment is too long');
      const bodyHash = createHash('sha256').update(body).digest();
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await requireVisible(client, req.params.id);
        if (!(await commentsEnabled(client, req.params.id)))
          throw conflict('comments_disabled', 'comments are disabled for this item');
        const settings = await readOrgSettings(client);
        if (settings.commentScanPolicy !== 'off') {
          const verdict = scanVerdict(settings.commentScanPolicy, scanComment(body));
          if (verdict.categories.length > 0)
            req.log.info(
              { categories: verdict.categories, contentId: req.params.id },
              'comment scan findings',
            );
          if (verdict.blocked)
            throw badRequest(
              'comment_blocked',
              `comment contains: ${verdict.categories.join(', ')}`,
            );
        }
        let rootId: string | null = null;
        if (req.body.parentId) {
          const parent = await client.query<{ id: string; root_id: string | null; state: string }>(
            `SELECT id, root_id, state FROM comment WHERE org_id = $1 AND id = $2 AND content_id = $3`,
            [auth.orgId, req.body.parentId, req.params.id],
          );
          const p = parent.rows[0];
          if (!p || p.state !== 'visible') throw notFound('bad_parent', 'parent comment not found');
          rootId = p.root_id ?? p.id;
        }
        const clientKey = req.body.clientKey ?? null;
        const ins = await client.query<{ id: string }>(
          `INSERT INTO comment (org_id, content_id, root_id, author_id, body, body_hash, client_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (org_id, author_id, content_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
           RETURNING id`,
          [auth.orgId, req.params.id, rootId, auth.userId, body, bodyHash, clientKey],
        );
        let id = ins.rows[0]?.id;
        if (!id) {
          // Replay of a client key: same body and thread → the original; otherwise the client is confused.
          const existing = await client.query<{
            id: string;
            body_hash: Buffer;
            root_id: string | null;
          }>(
            `SELECT id, body_hash, root_id FROM comment WHERE org_id = $1 AND author_id = $2 AND content_id = $3 AND client_key = $4`,
            [auth.orgId, auth.userId, req.params.id, clientKey],
          );
          const e = existing.rows[0];
          if (!e) throw conflict('idempotency_mismatch', 'retry failed; send a new client key');
          if (!e.body_hash.equals(bodyHash) || e.root_id !== rootId)
            throw conflict(
              'idempotency_mismatch',
              'this client key was used for a different comment',
            );
          id = e.id;
        } else {
          await client.query('SELECT platform_emit_event($1, $2, $3, $4, $5::jsonb)', [
            'comment.created',
            'content',
            req.params.id,
            null,
            JSON.stringify({ commentId: id, rootId }),
          ]);
        }
        return fullComment(client, await loadComment(client, id), auth.userId);
      });
    },
  );

  app.post(
    '/v1/comments/:id/report',
    {
      schema: {
        tags: ['comments'],
        params: Params,
        body: ReportCommentRequest,
        response: { 200: Ok },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.write, auth.sessionId);
      await withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await loadVisibleComment(client, req.params.id);
        const r = await client.query<{ ok: boolean | null }>(
          'SELECT comment_report($1, $2) AS ok',
          [req.params.id, req.body.reason],
        );
        if (r.rows[0]?.ok === null) throw notFound('comment_not_found', 'comment not found');
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/v1/comments/:id/remove',
    {
      schema: {
        tags: ['comments'],
        params: Params,
        body: RemoveCommentRequest,
        response: { 200: Comment },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.write, auth.sessionId);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await loadVisibleComment(client, req.params.id);
        try {
          const r = await client.query<{ ok: boolean | null }>(
            'SELECT comment_remove($1, $2) AS ok',
            [req.params.id, req.body.reason],
          );
          if (r.rows[0]?.ok === null) throw notFound('comment_not_found', 'comment not found');
        } catch (err) {
          if ((err as { code?: string }).code === '42501')
            throw forbidden(
              'moderation_forbidden',
              'only the author or a moderator may remove this comment',
            );
          throw err;
        }
        return fullComment(client, await loadComment(client, req.params.id), auth.userId);
      });
    },
  );

  app.post(
    '/v1/content/:id/share',
    {
      schema: {
        tags: ['reactions'],
        params: Params,
        body: ShareRequest,
        response: { 200: ShareResponse },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.share, auth.sessionId);
      if (req.body.userId === auth.userId)
        throw badRequest('self_share', 'cannot share with yourself');
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await requireVisible(client, req.params.id);
        // ADR-0002: the recipient sees the item iff they already pass readerVisible; unknown, deactivated
        // and no-access recipients are indistinguishable, and every attempt is audited (review F6).
        const r = await client.query<{ version_id: string | null }>(
          `SELECT c.current_version_id AS version_id FROM content c
           WHERE c.org_id = $1 AND c.id = $3 AND ${readerVisibleSql({ org: '$1', user: '$2' })}`,
          [auth.orgId, req.body.userId, req.params.id],
        );
        const delivered = (r.rowCount ?? 0) > 0;
        if (delivered) {
          await client.query(
            `INSERT INTO notification (org_id, user_id, kind, reason, content_id, version_id, dedupe_key, payload)
             VALUES ($1, $2, 'content.shared', 'shared', $3, $4, $5, $6::jsonb)
             ON CONFLICT (org_id, user_id, dedupe_key) DO NOTHING`,
            [
              auth.orgId,
              req.body.userId,
              req.params.id,
              r.rows[0]!.version_id,
              `shared:${req.params.id}:${auth.userId}`,
              JSON.stringify({ sharedBy: auth.userId }),
            ],
          );
        }
        await audit(client, 'content.shared', {
          contentId: req.params.id,
          recipientId: req.body.userId,
          delivered,
        });
        return { delivered, linkPath: `/content/${req.params.id}` };
      });
    },
  );
}
