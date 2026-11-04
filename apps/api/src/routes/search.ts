// SPDX-License-Identifier: AGPL-3.0-only
// Keyword search (ADR-0013). One filtered set drives results, total and snippets: readerVisibleSql in
// the WHERE of the hits CTE, stream/tag filters as further AND terms, the current version joined, and
// ts_headline run only over the page. Snippets leave as plain text plus UTF-16 ranges.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { readerVisibleSql } from '@our-stream/authz';
import { type SearchHit, SearchQuery, SearchResponse } from '@our-stream/contracts';
import { readEpochs, withTenant } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { requireMember } from '../lib/auth.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { requireBudget, streamFilterSql, tagFilterSql, viewerStreamsSql } from '../lib/m1b-sql.js';
import { feedMedia } from '../lib/media.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  HEADLINE_OPTIONS,
  headlineToSnippet,
  HL_END,
  HL_START,
  normalizeQuery,
} from '../lib/search-text.js';

const security = [{ cookieAuth: [] }, { bearerAuth: [] }];
type Hit = z.infer<typeof SearchHit>;
const TOTAL_CAP = 1000;

interface HitRow {
  id: string;
  publish_at: Date;
  score: string;
}
interface DetailRow {
  id: string;
  kind: Hit['kind'];
  title: string;
  description: string;
  publish_at: Date;
  owner_id: string;
  owner_name: string | null;
  tags: Hit['tags'];
  version_id: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  assets: unknown;
  streams: Hit['streams'];
  title_hl: string | null;
  desc_hl: string | null;
  transcript_hl: Array<{ text: string; tMs: number }>;
}

// $1 org, $2 user, $3 query text, $4 streamId|null, $5 tag|null
const HITS_CTE = `
  WITH q AS (SELECT websearch_to_tsquery('simple', $3::text) AS tsq),
  hits AS (
    SELECT c.id, c.publish_at,
           round(GREATEST(ts_rank_cd(c.search_tsv, q.tsq, 32),
                          COALESCE((SELECT max(ts_rank_cd(k.tsv, q.tsq, 32)) FROM chunk k
                                    WHERE k.org_id = c.org_id AND k.content_version_id = v.id AND k.tsv @@ q.tsq), 0))::numeric, 6) AS score
    FROM content c
    JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id AND v.status = 'current'
    CROSS JOIN q
    WHERE c.org_id = $1 AND c.kind IN ('clip', 'audio') AND v.assets ? 'hls'
      AND ${readerVisibleSql({ org: '$1', user: '$2' })}
      AND (c.search_tsv @@ q.tsq OR EXISTS (SELECT 1 FROM chunk k WHERE k.org_id = c.org_id AND k.content_version_id = v.id AND k.tsv @@ q.tsq))
      AND ${streamFilterSql('c', '$1', '$2', '$4')}
      AND ${tagFilterSql('c', '$5')}
  )`;

export function registerSearchRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/search',
    {
      schema: {
        tags: ['search'],
        querystring: SearchQuery,
        response: { 200: SearchResponse },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.search, auth.sessionId);
      const q = normalizeQuery(req.query.q);
      const cursor = req.query.cursor ? decodeSearchCursor(req.query.cursor) : null;
      if (req.query.cursor && !cursor) throw badRequest('bad_cursor', 'invalid cursor');
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const epochs = await readEpochs(client); // ADR-0004 key-read ordering
        if (!epochs.active) throw forbidden('not_member', 'membership is not active');
        const empty = {
          items: [] as Hit[],
          total: 0,
          nextCursor: null,
          authzEpoch: epochs.authzEpoch,
          orgContentEpoch: epochs.orgContentEpoch,
        };
        const lex = await client.query<{ n: number }>(
          `SELECT numnode(websearch_to_tsquery('simple', $1::text)) AS n`,
          [q],
        );
        if (q.length === 0 || (lex.rows[0]?.n ?? 0) === 0) return empty;
        const base = [
          auth.orgId,
          auth.userId,
          q,
          req.query.streamId ?? null,
          req.query.tag ?? null,
        ];
        const page = await client.query<HitRow>(
          `${HITS_CTE}
           SELECT id, publish_at, score::text FROM hits
           WHERE ($6::numeric IS NULL OR (score, publish_at, id) < ($6::numeric, $7::timestamptz, $8::uuid))
           ORDER BY score DESC, publish_at DESC, id DESC LIMIT $9`,
          [
            ...base,
            cursor?.score ?? null,
            cursor?.publishAt ?? null,
            cursor?.id ?? null,
            req.query.limit + 1,
          ],
        );
        const total = await client.query<{ n: number }>(
          `${HITS_CTE} SELECT count(*)::int AS n FROM (SELECT 1 FROM hits LIMIT ${TOTAL_CAP}) x`,
          base,
        );
        const rows = page.rows.slice(0, req.query.limit);
        if (rows.length === 0) return { ...empty, total: total.rows[0]?.n ?? 0 };
        const headline = `StartSel=${HL_START}, StopSel=${HL_END}, ${HEADLINE_OPTIONS}`;
        const details = await client.query<DetailRow>(
          `WITH q AS (SELECT websearch_to_tsquery('simple', $3::text) AS tsq)
           SELECT c.id, c.kind, c.title, c.description, c.publish_at, c.owner_id, a.display_name AS owner_name, c.event_tags AS tags,
                  v.id AS version_id, v.duration_ms, v.width, v.height, v.assets,
                  ${viewerStreamsSql('c', '$2')} AS streams,
                  CASE WHEN to_tsvector('simple', c.title) @@ q.tsq
                       THEN ts_headline('simple', translate(c.title, $5::text, ''), q.tsq, $6::text) END AS title_hl,
                  CASE WHEN to_tsvector('simple', c.description) @@ q.tsq
                       THEN ts_headline('simple', translate(c.description, $5::text, ''), q.tsq, $6::text) END AS desc_hl,
                  COALESCE((SELECT json_agg(json_build_object('text', ts_headline('simple', translate(k.text, $5::text, ''), q.tsq, $6::text),
                                                              'tMs', (k.locator ->> 'start_ms')::int) ORDER BY k.rank DESC, k.start_ms)
                            FROM (SELECT k.text, k.locator, ts_rank_cd(k.tsv, q.tsq) AS rank, (k.locator ->> 'start_ms')::int AS start_ms
                                  FROM chunk k WHERE k.org_id = c.org_id AND k.content_version_id = v.id AND k.tsv @@ q.tsq
                                  ORDER BY ts_rank_cd(k.tsv, q.tsq) DESC, (k.locator ->> 'start_ms')::int LIMIT 2) k), '[]'::json) AS transcript_hl
           FROM content c
           JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id
           LEFT JOIN LATERAL platform_account_get(c.owner_id) a ON true
           CROSS JOIN q
           WHERE c.org_id = $1 AND c.id = ANY($4::uuid[])`,
          [auth.orgId, auth.userId, q, rows.map((r) => r.id), HL_START + HL_END, headline],
        );
        const byId = new Map(details.rows.map((d) => [d.id, d]));
        const items: Hit[] = [];
        for (const r of rows) {
          const d = byId.get(r.id);
          if (!d) continue;
          const media = feedMedia(auth.orgId, d.id, d.version_id, d.assets);
          if (!media) continue;
          const snippets: Hit['snippets'] = [];
          if (d.title_hl)
            snippets.push({ source: 'title', ...headlineToSnippet(d.title_hl), tMs: null });
          if (d.desc_hl)
            snippets.push({ source: 'description', ...headlineToSnippet(d.desc_hl), tMs: null });
          for (const t of d.transcript_hl)
            snippets.push({ source: 'transcript', ...headlineToSnippet(t.text), tMs: t.tMs });
          items.push({
            id: d.id,
            kind: d.kind,
            title: d.title,
            description: d.description,
            publishAt: d.publish_at.toISOString(),
            owner: { id: d.owner_id, displayName: d.owner_name ?? 'unknown' },
            versionId: d.version_id,
            durationMs: d.duration_ms,
            width: d.width,
            height: d.height,
            media,
            streams: d.streams,
            tags: d.tags,
            snippets,
            score: Math.min(1, Math.max(0, Number(r.score))),
          });
        }
        const last = rows[rows.length - 1]!;
        return {
          items,
          total: total.rows[0]?.n ?? 0,
          nextCursor:
            page.rows.length > req.query.limit
              ? encodeSearchCursor({ score: last.score, publishAt: last.publish_at, id: last.id })
              : null,
          authzEpoch: epochs.authzEpoch,
          orgContentEpoch: epochs.orgContentEpoch,
        };
      });
    },
  );
}
