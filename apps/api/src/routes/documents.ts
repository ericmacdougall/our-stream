// SPDX-License-Identifier: AGPL-3.0-only
// M2a documents, reader side: viewer (parsed text with anchors), attachment download streamed by the API,
// the per-stream Documents list and keyword search over documents (ADR-0013 rules). Every query embeds
// readerVisibleSql, whose document gate also carries the org flag and the deployment kill switch, so a
// hidden, missing, other-org or flag-off document is one and the same answer: the neutral 404 below.
// Documents never enter the feed or the clip search; the clip/audio HLS clause in search.ts is untouched.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { readerVisibleSql } from '@our-stream/authz';
import {
  DocumentListQuery,
  DocumentListResponse,
  DocumentSearchQuery,
  DocumentSearchResponse,
  DocumentViewerQuery,
  DocumentViewerResponse,
  Uuid,
} from '@our-stream/contracts';
import { readEpochs, withTenant, type TenantClient } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { requireMember } from '../lib/auth.js';
import {
  anchorFromLocator,
  anchorKey,
  ATTACHMENT_SECURITY_HEADERS,
  canonicalMime,
  contentDisposition,
  formatOfName,
  parseSingleRange,
  type Anchor,
} from '../lib/documents.js';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { requireBudget, streamFilterSql, tagFilterSql, viewerStreamsSql } from '../lib/m1b-sql.js';
import { RangeNotSatisfiable } from '../lib/storage.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  HEADLINE_OPTIONS,
  headlineToSnippet,
  HL_END,
  HL_START,
  normalizeDocumentQuery,
} from '../lib/search-text.js';

const security = [{ cookieAuth: [] }, { bearerAuth: [] }];
const Params = z.object({ id: Uuid });
const TOTAL_CAP = 1000;

/**
 * The one answer for every document the caller may not open. Built by hand (not through the error handler,
 * whose body carries a per-request id) so status, headers other than Date, and body are byte-identical.
 */
const NEUTRAL_404 = JSON.stringify({ error: { code: 'not_found', message: 'not found' } });
function neutralNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).type('application/json; charset=utf-8').send(NEUTRAL_404);
}

type Doc = z.infer<typeof DocumentViewerResponse>['document'];

interface DocVersionRow {
  version_id: string;
  title: string;
  original_key: string | null;
  original_name: string | null;
  original_size: string | null;
}

/** The reader-visible document's current, processed version; null for anything else (one answer). */
async function visibleDocument(
  client: TenantClient,
  contentId: string,
): Promise<DocVersionRow | null> {
  const r = await client.query<DocVersionRow>(
    `SELECT v.id AS version_id, c.title, v.original_key, v.original_name, v.original_size::text
     FROM content c
     JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id AND v.status = 'current'
     WHERE c.org_id = $1 AND c.id = $3 AND c.kind = 'document'
       AND ${readerVisibleSql({ org: '$1', user: '$2' })}`,
    [client.tenant.orgId, client.tenant.userId, contentId],
  );
  return r.rows[0] ?? null;
}

function docInfo(name: string | null, mime: string | null, size: string | null): Doc | null {
  const format = formatOfName(name ?? '');
  if (!format) return null;
  return {
    format,
    fileName: name!,
    mimeType: mime ?? canonicalMime(format),
    size: Number(size ?? 0),
    scanStatus: 'not_run',
  };
}

/** Concurrent attachment streams: overall and per user (backpressure and abuse bound, per process). */
class DownloadSlots {
  private total = 0;
  private readonly perUser = new Map<string, number>();
  constructor(
    private readonly maxTotal: number,
    private readonly maxPerUser: number,
  ) {}
  acquire(user: string): (() => void) | null {
    const mine = this.perUser.get(user) ?? 0;
    if (this.total >= this.maxTotal || mine >= this.maxPerUser) return null;
    this.total += 1;
    this.perUser.set(user, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const n = (this.perUser.get(user) ?? 1) - 1;
      if (n <= 0) this.perUser.delete(user);
      else this.perUser.set(user, n);
    };
  }
}

interface SearchHitRow {
  id: string;
  publish_at: Date;
  score: string;
}
interface SearchDetailRow {
  id: string;
  title: string;
  description: string;
  publish_at: Date;
  owner_id: string;
  owner_name: string | null;
  tags: string[];
  version_id: string;
  original_name: string | null;
  original_size: string | null;
  mime_type: string | null;
  streams: Array<{ id: string; name: string; kind: string }>;
  title_hl: string | null;
  desc_hl: string | null;
  text_hl: Array<{ text: string; locator: unknown }>;
}

// $1 org, $2 user, $3 query text, $4 streamId|null, $5 tag|null. A separate branch from the clip/audio
// search: documents are the current, processed version of a `document` row and nothing else.
const DOC_HITS_CTE = `
  WITH q AS (SELECT websearch_to_tsquery('simple', $3::text) AS tsq),
  hits AS (
    SELECT c.id, c.publish_at,
           round(GREATEST(ts_rank_cd(c.search_tsv, q.tsq, 32),
                          COALESCE((SELECT max(ts_rank_cd(k.tsv, q.tsq, 32)) FROM chunk k
                                    WHERE k.org_id = c.org_id AND k.content_version_id = v.id AND k.tsv @@ q.tsq), 0))::numeric, 6) AS score
    FROM content c
    JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id AND v.status = 'current'
    CROSS JOIN q
    WHERE c.org_id = $1 AND c.kind = 'document'
      AND ${readerVisibleSql({ org: '$1', user: '$2' })}
      AND (c.search_tsv @@ q.tsq OR EXISTS (SELECT 1 FROM chunk k WHERE k.org_id = c.org_id AND k.content_version_id = v.id AND k.tsv @@ q.tsq))
      AND ${streamFilterSql('c', '$1', '$2', '$4')}
      AND ${tagFilterSql('c', '$5')}
  )`;

export function registerDocumentRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const slots = new DownloadSlots(
    ctx.config.DOCUMENT_DOWNLOAD_CONCURRENCY,
    ctx.config.DOCUMENT_DOWNLOAD_CONCURRENCY_PER_USER,
  );

  // ---- viewer ---------------------------------------------------------------------------------------
  app.get(
    '/v1/content/:id/document',
    {
      schema: {
        tags: ['documents'],
        params: Params,
        querystring: DocumentViewerQuery,
        response: { 200: DocumentViewerResponse },
        security,
      },
    },
    async (req, reply) => {
      const auth = requireMember(req);
      let after = -1;
      if (req.query.cursor) {
        const text = /^[A-Za-z0-9_-]{1,24}$/.test(req.query.cursor)
          ? Buffer.from(req.query.cursor, 'base64url').toString('utf8')
          : '';
        if (!/^\d{1,9}$/.test(text)) throw badRequest('bad_cursor', 'invalid cursor');
        after = Number(text);
      }
      const found = await withTenant(
        ctx.pool,
        { orgId: auth.orgId, userId: auth.userId },
        async (client) => {
          const doc = await visibleDocument(client, req.params.id);
          if (!doc) return null;
          const meta = await client.query<{ mime_type: string | null }>(
            'SELECT mime_type FROM content_version WHERE org_id = $1 AND id = $2',
            [auth.orgId, doc.version_id],
          );
          const chunks = await client.query<{ ordinal: number; locator: unknown; text: string }>(
            `SELECT ordinal, locator, text FROM chunk
             WHERE org_id = $1 AND content_version_id = $2 AND ordinal > $3
             ORDER BY ordinal LIMIT $4`,
            [auth.orgId, doc.version_id, after, req.query.limit + 1],
          );
          return { doc, mime: meta.rows[0]?.mime_type ?? null, chunks: chunks.rows };
        },
      );
      const info = found
        ? docInfo(found.doc.original_name, found.mime, found.doc.original_size)
        : null;
      if (!found || !info) return neutralNotFound(reply);
      const page = found.chunks.slice(0, req.query.limit);
      const sections: Array<{
        anchor: Anchor;
        chunks: Array<{ ordinal: number; text: string }>;
      }> = [];
      let lastKey = '';
      for (const c of page) {
        const anchor = anchorFromLocator(c.locator);
        const key = anchorKey(anchor);
        if (sections.length > 0 && key === lastKey) {
          sections[sections.length - 1]!.chunks.push({ ordinal: c.ordinal, text: c.text });
        } else {
          sections.push({ anchor, chunks: [{ ordinal: c.ordinal, text: c.text }] });
          lastKey = key;
        }
      }
      const last = page[page.length - 1];
      return {
        id: req.params.id,
        versionId: found.doc.version_id,
        title: found.doc.title,
        document: info,
        downloadPath: `/v1/content/${req.params.id}/document/original`,
        sections,
        nextCursor:
          found.chunks.length > req.query.limit && last
            ? Buffer.from(String(last.ordinal)).toString('base64url')
            : null,
      };
    },
  );

  // ---- original, as an attachment, streamed by the API ----------------------------------------------
  app.get(
    '/v1/content/:id/document/original',
    {
      schema: { tags: ['documents'], params: Params, security },
    },
    async (req, reply) => {
      const auth = requireMember(req);
      const found = await withTenant(
        ctx.pool,
        { orgId: auth.orgId, userId: auth.userId },
        async (client) => {
          const doc = await visibleDocument(client, req.params.id);
          if (!doc || !doc.original_key) return null;
          const meta = await client.query<{ mime_type: string | null }>(
            'SELECT mime_type FROM content_version WHERE org_id = $1 AND id = $2',
            [auth.orgId, doc.version_id],
          );
          return { doc, mime: meta.rows[0]?.mime_type ?? null };
        },
      );
      const format = found ? formatOfName(found.doc.original_name ?? '') : null;
      if (!found || !format) return neutralNotFound(reply);
      const size = Number(found.doc.original_size ?? NaN);
      if (!Number.isSafeInteger(size) || size < 0 || size > ctx.config.DOCUMENT_MAX_BYTES) {
        req.log.error({ contentId: req.params.id }, 'document original has an unusable size');
        return neutralNotFound(reply);
      }
      const range = parseSingleRange(
        typeof req.headers.range === 'string' ? req.headers.range : undefined,
        size,
      );
      if (range === 'invalid') {
        return reply.code(416).header('content-range', `bytes */${size}`).send();
      }
      const release = slots.acquire(auth.userId);
      if (!release) throw new ApiError(429, 'rate_limited', 'too many downloads in progress');
      try {
        const obj = await ctx.store.get(
          found.doc.original_key!,
          range ? `bytes=${range.start}-${range.end}` : undefined,
        );
        if (!obj) {
          release();
          req.log.warn({ contentId: req.params.id }, 'document original is missing from storage');
          return neutralNotFound(reply);
        }
        reply.raw.once('close', release);
        reply
          .code(range ? 206 : 200)
          .header('content-type', canonicalMime(format))
          .header('content-disposition', contentDisposition(found.doc.original_name!))
          .header('accept-ranges', 'bytes')
          .header(
            'content-length',
            String(range ? range.end - range.start + 1 : (obj.contentLength ?? size)),
          );
        if (range) reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
        for (const [k, v] of Object.entries(ATTACHMENT_SECURITY_HEADERS)) reply.header(k, v);
        // Fastify pipes the stream with backpressure and destroys it when the client goes away.
        return reply.send(obj.body);
      } catch (err) {
        release();
        if (err instanceof RangeNotSatisfiable)
          return reply.code(416).header('content-range', `bytes */${size}`).send();
        throw err;
      }
    },
  );

  // ---- per-stream Documents list --------------------------------------------------------------------
  app.get(
    '/v1/streams/:id/documents',
    {
      schema: {
        tags: ['documents'],
        params: Params,
        querystring: DocumentListQuery,
        response: { 200: DocumentListResponse },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      const cursor = req.query.cursor ? decodeListCursor(req.query.cursor) : null;
      if (req.query.cursor && !cursor) throw badRequest('bad_cursor', 'invalid cursor');
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        // Same visibility as the stream list: a private stream exists only for members holding a role on it.
        const visible = await client.query(
          `SELECT 1 FROM stream s LEFT JOIN user_stream_access usa
             ON usa.org_id = s.org_id AND usa.stream_id = s.id AND usa.user_id = $2
           WHERE s.org_id = $1 AND s.id = $3 AND (s.kind <> 'private' OR usa.role IS NOT NULL)`,
          [auth.orgId, auth.userId, req.params.id],
        );
        if ((visible.rowCount ?? 0) === 0) throw notFound('stream_not_found', 'stream not found');
        const rows = await client.query<{
          id: string;
          title: string;
          description: string;
          publish_at: Date;
          owner_id: string;
          owner_name: string | null;
          tags: string[];
          version_id: string;
          original_name: string | null;
          original_size: string | null;
          mime_type: string | null;
        }>(
          `SELECT c.id, c.title, c.description, c.publish_at, c.owner_id, a.display_name AS owner_name,
                  c.event_tags AS tags, v.id AS version_id, v.original_name, v.original_size::text, v.mime_type
           FROM content c
           JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id AND v.status = 'current'
           LEFT JOIN LATERAL platform_account_get(c.owner_id) a ON true
           WHERE c.org_id = $1 AND c.kind = 'document'
             AND ${readerVisibleSql({ org: '$1', user: '$2' })}
             AND EXISTS (SELECT 1 FROM content_audience au WHERE au.org_id = c.org_id AND au.content_id = c.id
                         AND au.kind = 'stream' AND au.principal_id = $3)
             AND ($4::timestamptz IS NULL OR (c.publish_at, c.id) < ($4::timestamptz, $5::uuid))
           ORDER BY c.publish_at DESC, c.id DESC LIMIT $6`,
          [
            auth.orgId,
            auth.userId,
            req.params.id,
            cursor?.publishAt ?? null,
            cursor?.id ?? null,
            req.query.limit + 1,
          ],
        );
        const page = rows.rows.slice(0, req.query.limit);
        const items = page.flatMap((r) => {
          const document = docInfo(r.original_name, r.mime_type, r.original_size);
          if (!document) return [];
          return [
            {
              id: r.id,
              title: r.title,
              description: r.description,
              publishAt: r.publish_at.toISOString(),
              owner: { id: r.owner_id, displayName: r.owner_name ?? 'unknown' },
              versionId: r.version_id,
              document,
              tags: r.tags as never[],
            },
          ];
        });
        const last = page[page.length - 1];
        return {
          items,
          nextCursor:
            rows.rows.length > req.query.limit && last
              ? Buffer.from(JSON.stringify([last.publish_at.toISOString(), last.id])).toString(
                  'base64url',
                )
              : null,
        };
      });
    },
  );

  // ---- keyword search over documents ----------------------------------------------------------------
  app.get(
    '/v1/search/documents',
    {
      schema: {
        tags: ['search'],
        querystring: DocumentSearchQuery,
        response: { 200: DocumentSearchResponse },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      // Shared with the retrieval route: 60 per user per minute, keyed by the validated user id.
      requireBudget(ctx.limits.documentQuery, auth.userId);
      const q = normalizeDocumentQuery(req.query.q);
      const cursor = req.query.cursor ? decodeSearchCursor(req.query.cursor) : null;
      if (req.query.cursor && !cursor) throw badRequest('bad_cursor', 'invalid cursor');
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const epochs = await readEpochs(client); // ADR-0004 key-read ordering
        if (!epochs.active) throw forbidden('not_member', 'membership is not active');
        const empty = {
          items: [],
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
        const page = await client.query<SearchHitRow>(
          `${DOC_HITS_CTE}
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
          `${DOC_HITS_CTE} SELECT count(*)::int AS n FROM (SELECT 1 FROM hits LIMIT ${TOTAL_CAP}) x`,
          base,
        );
        const rows = page.rows.slice(0, req.query.limit);
        if (rows.length === 0) return { ...empty, total: total.rows[0]?.n ?? 0 };
        const headline = `StartSel=${HL_START}, StopSel=${HL_END}, ${HEADLINE_OPTIONS}`;
        const details = await client.query<SearchDetailRow>(
          `WITH q AS (SELECT websearch_to_tsquery('simple', $3::text) AS tsq)
           SELECT c.id, c.title, c.description, c.publish_at, c.owner_id, a.display_name AS owner_name, c.event_tags AS tags,
                  v.id AS version_id, v.original_name, v.original_size::text, v.mime_type,
                  ${viewerStreamsSql('c', '$2')} AS streams,
                  CASE WHEN to_tsvector('simple', c.title) @@ q.tsq
                       THEN ts_headline('simple', translate(c.title, $5::text, ''), q.tsq, $6::text) END AS title_hl,
                  CASE WHEN to_tsvector('simple', c.description) @@ q.tsq
                       THEN ts_headline('simple', translate(c.description, $5::text, ''), q.tsq, $6::text) END AS desc_hl,
                  COALESCE((SELECT json_agg(json_build_object('text', ts_headline('simple', translate(k.text, $5::text, ''), q.tsq, $6::text),
                                                              'locator', k.locator) ORDER BY k.rank DESC, k.ordinal)
                            FROM (SELECT k.text, k.locator, k.ordinal, ts_rank_cd(k.tsv, q.tsq) AS rank
                                  FROM chunk k WHERE k.org_id = c.org_id AND k.content_version_id = v.id AND k.tsv @@ q.tsq
                                  ORDER BY ts_rank_cd(k.tsv, q.tsq) DESC, k.ordinal LIMIT 2) k), '[]'::json) AS text_hl
           FROM content c
           JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id
           LEFT JOIN LATERAL platform_account_get(c.owner_id) a ON true
           CROSS JOIN q
           WHERE c.org_id = $1 AND c.id = ANY($4::uuid[])`,
          [auth.orgId, auth.userId, q, rows.map((r) => r.id), HL_START + HL_END, headline],
        );
        const byId = new Map(details.rows.map((d) => [d.id, d]));
        const items = [];
        for (const r of rows) {
          const d = byId.get(r.id);
          const document = d ? docInfo(d.original_name, d.mime_type, d.original_size) : null;
          if (!d || !document) continue;
          const snippets: Array<{
            source: 'title' | 'description' | 'text';
            text: string;
            ranges: Array<[number, number]>;
            anchor: Anchor | null;
          }> = [];
          if (d.title_hl)
            snippets.push({ source: 'title', ...headlineToSnippet(d.title_hl), anchor: null });
          if (d.desc_hl)
            snippets.push({ source: 'description', ...headlineToSnippet(d.desc_hl), anchor: null });
          for (const t of d.text_hl)
            snippets.push({
              source: 'text',
              ...headlineToSnippet(t.text),
              anchor: anchorFromLocator(t.locator),
            });
          items.push({
            id: d.id,
            kind: 'document' as const,
            title: d.title,
            description: d.description,
            publishAt: d.publish_at.toISOString(),
            owner: { id: d.owner_id, displayName: d.owner_name ?? 'unknown' },
            versionId: d.version_id,
            document,
            streams: d.streams as never[],
            tags: d.tags as never[],
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

function decodeListCursor(cursor: string): { publishAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [iso, id] = parsed as [unknown, unknown];
    if (typeof iso !== 'string' || typeof id !== 'string') return null;
    if (!Uuid.safeParse(id).success) return null;
    const publishAt = new Date(iso);
    return Number.isNaN(publishAt.getTime()) ? null : { publishAt, id };
  } catch {
    return null;
  }
}
