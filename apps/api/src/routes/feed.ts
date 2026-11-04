// SPDX-License-Identifier: AGPL-3.0-only
// Reader paths: feed, sync and notifications. Every query embeds readerVisibleSql (ADR-0002) and the
// epochs are read before the query inside the same transaction (ADR-0004 key-read ordering).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { readerVisibleSql } from '@our-stream/authz';
import {
  type FeedItem,
  FeedQuery,
  FeedResponse,
  NotificationList,
  Ok,
  SyncResponse,
  Uuid,
} from '@our-stream/contracts';
import { readEpochs, withTenant } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { requireMember } from '../lib/auth.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { feedMedia } from '../lib/media.js';

const security = [{ cookieAuth: [] }, { bearerAuth: [] }];
type Item = z.infer<typeof FeedItem>;

interface FeedRow {
  id: string;
  kind: 'clip' | 'audio';
  title: string;
  description: string;
  language: string;
  links: unknown;
  chapters: unknown;
  publish_at: Date;
  owner_id: string;
  owner_name: string | null;
  version_id: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  assets: unknown;
  streams: Array<{ id: string; name: string; kind: Item['streams'][number]['kind'] }>;
  viewed: boolean;
  content_epoch: string;
}

export function registerFeedRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/feed',
    {
      schema: { tags: ['feed'], querystring: FeedQuery, response: { 200: FeedResponse }, security },
    },
    async (req) => {
      const auth = requireMember(req);
      const q = req.query;
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      if (q.cursor && !cursor) throw badRequest('bad_cursor', 'invalid cursor');
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const epochs = await readEpochs(client); // before the query it keys (ADR-0004)
        if (!epochs.active) throw forbidden('not_member', 'membership is not active');
        const r = await client.query<FeedRow>(
          `SELECT c.id, c.kind, c.title, c.description, c.language, c.links, c.chapters, c.publish_at, c.owner_id,
                  a.display_name AS owner_name, c.content_epoch::text,
                  v.id AS version_id, v.duration_ms, v.width, v.height, v.assets,
                  EXISTS (SELECT 1 FROM user_content_state s WHERE s.org_id = c.org_id AND s.user_id = $2 AND s.content_id = c.id
                          AND s.first_viewed_at IS NOT NULL) AS viewed,
                  COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'kind', s.kind) ORDER BY s.name)
                            FROM content_audience au
                            JOIN stream s ON s.org_id = au.org_id AND s.id = au.principal_id
                            JOIN user_stream_access usa ON usa.org_id = au.org_id AND usa.stream_id = au.principal_id AND usa.user_id = $2
                            WHERE au.org_id = c.org_id AND au.content_id = c.id AND au.kind = 'stream'), '[]'::json) AS streams
           FROM content c
           JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id AND v.status = 'current'
           LEFT JOIN LATERAL platform_account_get(c.owner_id) a ON true
           WHERE c.org_id = $1 AND c.kind IN ('clip', 'audio') AND v.assets ? 'hls'
             AND ${readerVisibleSql({ org: '$1', user: '$2' })}
             AND ($3::uuid IS NULL OR (
                   EXISTS (SELECT 1 FROM user_stream_access usa WHERE usa.org_id = $1 AND usa.user_id = $2 AND usa.stream_id = $3)
                   AND EXISTS (SELECT 1 FROM content_audience au WHERE au.org_id = c.org_id AND au.content_id = c.id AND au.kind = 'stream' AND au.principal_id = $3)))
             AND ($4::timestamptz IS NULL OR (c.publish_at, c.id) < ($4::timestamptz, $5::uuid))
           ORDER BY c.publish_at DESC, c.id DESC
           LIMIT $6`,
          [
            auth.orgId,
            auth.userId,
            q.streamId ?? null,
            cursor?.publishAt ?? null,
            cursor?.id ?? null,
            q.limit + 1,
          ],
        );
        const rows = r.rows.slice(0, q.limit);
        const items: Item[] = [];
        for (const row of rows) {
          const media = feedMedia(auth.orgId, row.id, row.version_id, row.assets);
          if (!media) continue; // assets without a master playlist are not playable yet
          items.push({
            id: row.id,
            kind: row.kind,
            title: row.title,
            description: row.description,
            language: row.language,
            links: Array.isArray(row.links) ? (row.links as Item['links']) : [],
            chapters: Array.isArray(row.chapters)
              ? (row.chapters as Array<{ at_ms: number; title: string }>).map((ch) => ({
                  atMs: Number(ch.at_ms ?? 0),
                  title: String(ch.title),
                }))
              : [],
            publishAt: row.publish_at.toISOString(),
            owner: { id: row.owner_id, displayName: row.owner_name ?? 'unknown' },
            versionId: row.version_id,
            durationMs: row.duration_ms,
            width: row.width,
            height: row.height,
            media,
            streams: row.streams,
            viewed: row.viewed,
            contentEpoch: Number(row.content_epoch),
          });
        }
        const last = rows[rows.length - 1];
        return {
          items,
          nextCursor:
            r.rows.length > q.limit && last ? encodeCursor(last.publish_at, last.id) : null,
          authzEpoch: epochs.authzEpoch,
          orgContentEpoch: epochs.orgContentEpoch,
        };
      });
    },
  );

  app.get(
    '/v1/sync',
    { schema: { tags: ['feed'], response: { 200: SyncResponse }, security } },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const epochs = await readEpochs(client);
        if (!epochs.active) throw forbidden('not_member', 'membership is not active');
        return {
          authzEpoch: epochs.authzEpoch,
          orgContentEpoch: epochs.orgContentEpoch,
          serverTime: new Date().toISOString(),
        };
      });
    },
  );

  app.get(
    '/v1/notifications',
    { schema: { tags: ['notifications'], response: { 200: NotificationList }, security } },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        // Title: the live title only while the recipient still passes readerVisible; otherwise the
        // view-time snapshot (org opt-in, ADR-0005) or nothing.
        const r = await client.query<{
          id: string;
          kind: string;
          reason: string;
          content_id: string | null;
          title: string | null;
          created_at: Date;
          read_at: Date | null;
        }>(
          `SELECT n.id, n.kind, n.reason, n.content_id,
                  CASE WHEN c.id IS NOT NULL AND ${readerVisibleSql({ org: '$1', user: '$2' })} THEN c.title
                       ELSE n.title_snapshot END AS title,
                  n.created_at, n.read_at
           FROM notification n
           LEFT JOIN content c ON c.org_id = n.org_id AND c.id = n.content_id
           WHERE n.org_id = $1 AND n.user_id = $2
           ORDER BY n.created_at DESC, n.id LIMIT 100`,
          [auth.orgId, auth.userId],
        );
        const unread = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM notification WHERE org_id = $1 AND user_id = $2 AND read_at IS NULL',
          [auth.orgId, auth.userId],
        );
        return {
          items: r.rows.map((n) => ({
            id: n.id,
            kind: n.kind,
            reason: n.reason,
            contentId: n.content_id,
            title: n.title,
            createdAt: n.created_at.toISOString(),
            readAt: n.read_at?.toISOString() ?? null,
          })),
          unread: unread.rows[0]?.n ?? 0,
        };
      });
    },
  );

  app.post(
    '/v1/notifications/:id/read',
    {
      schema: {
        tags: ['notifications'],
        params: z.object({ id: Uuid }),
        response: { 200: Ok },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      await withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const r = await client.query(
          'UPDATE notification SET read_at = COALESCE(read_at, now()) WHERE org_id = $1 AND user_id = $2 AND id = $3',
          [auth.orgId, auth.userId, req.params.id],
        );
        if ((r.rowCount ?? 0) === 0)
          throw notFound('notification_not_found', 'notification not found');
      });
      return { ok: true as const };
    },
  );
}
