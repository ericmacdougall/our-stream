// SPDX-License-Identifier: AGPL-3.0-only
// Retrieval engine (M2a AC-4/AC-5, NEG-3..6). Runs inside the caller's REPEATABLE READ tenant transaction:
// keyword leg + approximate vector leg (HNSW, iterative scan) + a bounded exact-scan fallback, fused by
// reciprocal rank, then hydrated and re-decided by the independent reference predicate. Authorization is
// the predicate in the SQL (readerVisibleSql with ONE captured :now); no model and no cache decides it.
import { documentGateSql, readerVisibleSql } from '@our-stream/authz';
import type { TenantClient } from '@our-stream/db';
import {
  FALLBACK_ROW_CAP,
  FALLBACK_TIMEOUT_MS,
  HNSW_EF_SEARCH,
  HNSW_ITERATIVE_SCAN,
  HNSW_MAX_SCAN_TUPLES,
  OVERFETCH,
  RRF_K,
  SNIPPET_CHARS,
} from './constants.js';
import {
  referencePostCheck,
  type CheckedChunk,
  type loadScopedSnapshot,
} from './reference-check.js';
import type { TrySemaphore } from './semaphore.js';

export type RetrievalMode = 'hybrid' | 'keyword_only';
export type DegradedReason =
  | 'embed_unavailable'
  | 'embed_timeout'
  | 'embed_refused'
  | 'pin_mismatch'
  | 'fallback_busy'
  | 'fallback_timeout'
  | 'fallback_cap'
  | 'vector_unavailable';

/** Deliberately broken variants for the failing-first tests. Production never sets one. */
export type EngineVariant =
  | 'wrong_predicate'
  | 'leak_without_post_check'
  | 'returns_nothing'
  | 'wrong_version'
  | 'no_document_gate'
  | 'no_timeout_restore'
  | 'no_index'
  | 'no_fallback';

export interface Tuning {
  efSearch: number;
  maxScanTuples: number;
  fallbackTimeoutMs: number;
  fallbackRowCap: number;
}

export const DEFAULT_TUNING: Tuning = {
  efSearch: HNSW_EF_SEARCH,
  maxScanTuples: HNSW_MAX_SCAN_TUPLES,
  fallbackTimeoutMs: FALLBACK_TIMEOUT_MS,
  fallbackRowCap: FALLBACK_ROW_CAP,
};

/** Test seams (awaited at the named points); production passes none. */
export interface EngineHooks {
  /** After the candidate legs, before hydration and the post-check. */
  afterLegs?: (client: TenantClient) => Promise<void>;
  /** Replaces the scoped snapshot loader (failure injection). */
  loader?: typeof loadScopedSnapshot;
  /** Inside the fallback's SAVEPOINT, after statement_timeout was lowered, before the exact scan. */
  inFallback?: (client: TenantClient) => Promise<void>;
  /** Runs right before the loader, after any fallback (statement_timeout restore test). */
  beforeLoader?: (client: TenantClient) => Promise<void>;
}

export interface EngineInput {
  orgId: string;
  userId: string;
  /** Normalised query text. */
  query: string;
  k: number;
  /** The one captured :now of the request. */
  now: Date;
  /** Query embedding, or null for keyword-only (with `degraded` saying why). */
  queryVector: number[] | null;
  degraded: DegradedReason | null;
  /** Embedder model; compared with the active pin. Null when there is no embedder. */
  embedderModel: string | null;
  /** Cached permitted content ids (a hit narrows candidates) or null. */
  permittedIds: string[] | null;
  semaphore: TrySemaphore;
  tuning?: Partial<Tuning>;
  variant?: EngineVariant;
  hooks?: EngineHooks;
}

export interface RetrievedChunk {
  chunkId: string;
  contentId: string;
  versionId: string;
  kind: 'clip' | 'audio' | 'document';
  locator: Record<string, unknown>;
  snippet: string;
  score: number;
}

export interface EngineResult {
  items: RetrievedChunk[];
  retrievalMode: RetrievalMode;
  degraded: DegradedReason | null;
  /** Permitted content ids computed on a cache miss (null when a hit was used or the set is too large). */
  computedPermitted: string[] | null;
  pinId: string | null;
  fallbackUsed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

export interface BuiltSql {
  text: string;
  values: unknown[];
}

const isLeakingPredicate = (v: EngineVariant | undefined): boolean =>
  v === 'wrong_predicate' || v === 'leak_without_post_check';

/** The predicate fragment shared by every leg: readerVisible + the current published version of the content. */
function permittedSql(
  p: Params,
  input: Pick<EngineInput, 'orgId' | 'userId' | 'now' | 'permittedIds'>,
  variant: EngineVariant | undefined,
  refs: { org: string; user: string; now: string },
): string {
  const pred = { org: refs.org, user: refs.user, now: `${refs.now}::timestamptz` };
  let visible = isLeakingPredicate(variant)
    ? `(c.org_id = ${refs.org} AND ${refs.user}::uuid IS NOT NULL AND ${refs.now}::timestamptz IS NOT NULL)` // leaks drafts, other audiences and removed members
    : readerVisibleSql(pred);
  // A predicate that forgot only the document gate (flag, kill switch, version status).
  if (variant === 'no_document_gate') visible = visible.replace(documentGateSql(pred), 'true');
  const ids = input.permittedIds ? ` AND c.id = ANY(${p.add(input.permittedIds)}::uuid[])` : '';
  return `${visible}${ids}`;
}

const currentJoin = (variant: EngineVariant | undefined): string =>
  variant === 'wrong_version'
    ? // broken: serves chunks of any version of a visible content item
      `
  JOIN content c ON c.org_id = ch.org_id AND c.id = ch.content_id
  JOIN content_version v ON v.org_id = ch.org_id AND v.id = ch.content_version_id`
    : `
  JOIN content c ON c.org_id = ch.org_id AND c.id = ch.content_id AND c.current_version_id = ch.content_version_id
  JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id AND v.status = 'current'`;

export function buildKeywordSql(input: EngineInput, limit: number): BuiltSql {
  const p = new Params();
  const org = p.add(input.orgId);
  const user = p.add(input.userId);
  const now = p.add(input.now);
  const q = p.add(input.query);
  const where = permittedSql(p, input, input.variant, { org, user, now });
  const lim = p.add(limit);
  return {
    text: `SELECT ch.id::text AS id, ts_rank_cd(ch.tsv, qq.tsq, 32)::float8 AS score
             FROM (SELECT websearch_to_tsquery('simple', ${q}::text) AS tsq) qq
             CROSS JOIN chunk ch ${currentJoin(input.variant)}
            WHERE ch.org_id = ${org} AND ch.tsv @@ qq.tsq AND ${where}
            ORDER BY score DESC, ch.id
            LIMIT ${lim}`,
    values: p.values,
  };
}

/** The approximate leg. The active pin id is a LITERAL in the text (never a bind parameter) so the planner
 * can match the partial HNSW index under generic and prepared plans. */
export function buildApproxSql(input: EngineInput, pinId: string, limit: number): BuiltSql {
  if (!UUID_RE.test(pinId)) throw new Error('pin id must be a UUID');
  if (!input.queryVector) throw new Error('approximate leg needs a query vector');
  const p = new Params();
  const org = p.add(input.orgId);
  const user = p.add(input.userId);
  const now = p.add(input.now);
  const vec = p.add(vectorLiteral(input.queryVector));
  const where = permittedSql(p, input, input.variant, { org, user, now });
  const lim = p.add(limit);
  return {
    // relaxed_order may return slightly out of order; the MATERIALIZED CTE is re-sorted below.
    text: `WITH approx AS MATERIALIZED (
             SELECT x.id, e.vector <=> ${vec}::vector AS dist
               FROM embedding e
              CROSS JOIN LATERAL (
                SELECT ch.id
                  FROM chunk ch ${currentJoin(input.variant)}
                 WHERE ch.org_id = e.org_id AND ch.text_sha256 = e.text_sha256 AND ${where}
                OFFSET 0) x
              WHERE e.org_id = ${org} AND e.pin_id = '${pinId.toLowerCase()}'::uuid
              ORDER BY e.vector <=> ${vec}::vector
              LIMIT ${lim})
           SELECT id::text AS id, dist::float8 AS dist FROM approx ORDER BY dist, id`,
    values: p.values,
  };
}

/** Exact scan over the permitted set: candidates are capped (cap + 1 rows detect an overrun), ranked by distance. */
export function buildExactSql(
  input: EngineInput,
  pinId: string,
  limit: number,
  rowCap: number,
): BuiltSql {
  if (!UUID_RE.test(pinId)) throw new Error('pin id must be a UUID');
  if (!input.queryVector) throw new Error('exact scan needs a query vector');
  const p = new Params();
  const org = p.add(input.orgId);
  const user = p.add(input.userId);
  const now = p.add(input.now);
  const vec = p.add(vectorLiteral(input.queryVector));
  const where = permittedSql(p, input, input.variant, { org, user, now });
  const cap = p.add(rowCap + 1);
  const lim = p.add(limit);
  return {
    text: `WITH cand AS MATERIALIZED (
             SELECT ch.id, e.vector AS vec
               FROM embedding e
               JOIN chunk ch ON ch.org_id = e.org_id AND ch.text_sha256 = e.text_sha256 ${currentJoin(input.variant)}
              WHERE e.org_id = ${org} AND e.pin_id = '${pinId.toLowerCase()}'::uuid AND ${where}
              LIMIT ${cap}),
           ranked AS (SELECT id, vec <=> ${vec}::vector AS dist FROM cand ORDER BY dist, id LIMIT ${lim})
           SELECT id::text AS id, dist::float8 AS dist, (SELECT count(*) FROM cand)::int AS scanned FROM ranked ORDER BY dist, id`,
    values: p.values,
  };
}

/** The permitted content ids of the asker (cache fill). Capped so an over-large set is detected cheaply. */
export function buildPermittedSql(input: EngineInput, cap: number): BuiltSql {
  const p = new Params();
  const org = p.add(input.orgId);
  const user = p.add(input.userId);
  const now = p.add(input.now);
  const where = permittedSql(p, { ...input, permittedIds: null }, input.variant, {
    org,
    user,
    now,
  });
  const lim = p.add(cap + 1);
  return {
    text: `SELECT c.id::text AS id
             FROM content c JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id AND v.status = 'current'
            WHERE c.org_id = ${org} AND ${where}
            ORDER BY c.id LIMIT ${lim}`,
    values: p.values,
  };
}

export function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => Number(x).toString()).join(',')}]`;
}

const isStatementTimeout = (err: unknown): boolean => (err as { code?: string }).code === '57014';

/** Reciprocal-rank fusion over the legs; ties break by chunk id so the order is deterministic. */
export function fuse(
  legs: ReadonlyArray<readonly string[]>,
  k: number,
): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  for (const leg of legs) {
    leg.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, k);
}

interface Pin {
  id: string;
  model: string;
  dims: number;
}

export async function activePin(client: TenantClient): Promise<Pin | null> {
  const r = await client.query<Pin>(
    'SELECT id::text AS id, model, dims FROM platform_embedding_active_pin()',
  );
  return r.rows[0] ?? null;
}

/**
 * Settings of the approximate leg, applied transaction-locally: the fixed iterative-scan values, and
 * enable_sort = off so the planner takes the ORDER BY from the HNSW index scan (a nested loop preserves the
 * outer index order) instead of a sort over the join, which would be an exact scan. The caller restores
 * enable_sort afterwards with restoreSort. `no_index` is the broken variant that disables the index scan.
 */
export async function applyApproxSettings(
  client: TenantClient,
  tuning: Tuning,
  variant?: EngineVariant,
): Promise<string> {
  const prev = await client.query<{ v: string }>(`SELECT current_setting('enable_sort') AS v`);
  await client.query(
    `SELECT set_config('hnsw.iterative_scan', '${HNSW_ITERATIVE_SCAN}', true),
            set_config('hnsw.ef_search', $1, true),
            set_config('hnsw.max_scan_tuples', $2, true),
            set_config('enable_sort', 'off', true)`,
    [String(tuning.efSearch), String(tuning.maxScanTuples)],
  );
  if (variant === 'no_index')
    await client.query(`SELECT set_config('enable_indexscan', 'off', true)`);
  return prev.rows[0]?.v ?? 'on';
}

export async function restoreSort(client: TenantClient, previous: string): Promise<void> {
  await client.query(`SELECT set_config('enable_sort', $1, true)`, [previous]);
}

export async function retrieve(client: TenantClient, input: EngineInput): Promise<EngineResult> {
  const tuning: Tuning = { ...DEFAULT_TUNING, ...input.tuning };
  const limit = input.k * OVERFETCH;
  let degraded = input.degraded;
  let computedPermitted: string[] | null = null;
  let fallbackUsed = false;

  if (input.permittedIds === null && !isLeakingPredicate(input.variant)) {
    const q = buildPermittedSql(input, 5000);
    const r = await client.query<{ id: string }>(q.text, q.values);
    if (r.rows.length <= 5000) computedPermitted = r.rows.map((x) => x.id);
  }

  const kw = buildKeywordSql(input, limit);
  const lexical = await client.query<{ n: number }>(
    `SELECT numnode(websearch_to_tsquery('simple', $1::text)) AS n`,
    [input.query],
  );
  const keywordIds =
    input.query.length > 0 && (lexical.rows[0]?.n ?? 0) > 0
      ? (await client.query<{ id: string }>(kw.text, kw.values)).rows.map((r) => r.id)
      : [];

  let vectorIds: string[] = [];
  let pin: Pin | null = null;
  if (input.queryVector && !degraded) {
    pin = await activePin(client);
    if (!pin || pin.dims !== input.queryVector.length) degraded = 'vector_unavailable';
    else if (input.embedderModel !== pin.model) degraded = 'pin_mismatch';
  }
  if (input.queryVector && !degraded && pin) {
    const prevSort = await applyApproxSettings(client, tuning, input.variant);
    const a = buildApproxSql(input, pin.id, limit);
    const approx = await client.query<{ id: string }>(a.text, a.values);
    await restoreSort(client, prevSort);
    vectorIds = approx.rows.map((r) => r.id);
    // Exact-scan fallback: the approximate leg came back with fewer than k rows although more permitted
    // vectors may exist (pgvector does not report that max_scan_tuples was hit).
    if (vectorIds.length < input.k && input.variant !== 'no_fallback') {
      const release = input.semaphore.tryAcquire();
      if (!release) {
        degraded = 'fallback_busy';
        vectorIds = [];
      } else {
        try {
          fallbackUsed = true;
          const outcome = await runExactFallback(client, input, pin.id, limit, tuning);
          if (outcome.kind === 'ok') vectorIds = outcome.ids;
          else {
            degraded = outcome.kind;
            vectorIds = [];
          }
        } finally {
          release();
        }
      }
    }
  }
  const keywordOnly = degraded !== null || (vectorIds.length === 0 && !input.queryVector);
  await input.hooks?.afterLegs?.(client);

  const fused = fuse([keywordIds, vectorIds], input.k);
  let items: RetrievedChunk[] = [];
  if (fused.length > 0) items = await hydrate(client, input, fused);
  if (input.variant === 'returns_nothing') items = [];

  await input.hooks?.beforeLoader?.(client);
  if (input.variant !== 'leak_without_post_check') {
    const checked: CheckedChunk[] = items.map((i) => ({
      chunkId: i.chunkId,
      contentId: i.contentId,
      versionId: i.versionId,
    }));
    await referencePostCheck(
      client,
      input.orgId,
      input.userId,
      input.now,
      checked,
      input.hooks?.loader,
    );
  }
  return {
    items,
    retrievalMode: keywordOnly ? 'keyword_only' : 'hybrid',
    degraded,
    computedPermitted,
    pinId: pin?.id ?? null,
    fallbackUsed,
  };
}

type FallbackOutcome =
  { kind: 'ok'; ids: string[] } | { kind: 'fallback_timeout' | 'fallback_cap' };

/**
 * The bounded exact scan: SAVEPOINT, SET LOCAL statement_timeout, capped candidates. A timeout rolls back to
 * the savepoint (the snapshot survives). After a successful RELEASE the transaction would keep the short
 * timeout, so the previous value is restored with set_config(..., true) (the loader and hydration queries
 * that follow must not inherit 200 ms).
 */
async function runExactFallback(
  client: TenantClient,
  input: EngineInput,
  pinId: string,
  limit: number,
  tuning: Tuning,
): Promise<FallbackOutcome> {
  const saved = await client.query<{ v: string }>(
    `SELECT current_setting('statement_timeout') AS v`,
  );
  const previous = saved.rows[0]?.v ?? '0';
  const q = buildExactSql(input, pinId, limit, tuning.fallbackRowCap);
  await client.query('SAVEPOINT retrieval_fallback');
  try {
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
      String(tuning.fallbackTimeoutMs),
    ]);
    await input.hooks?.inFallback?.(client);
    const r = await client.query<{ id: string; scanned: number }>(q.text, q.values);
    await client.query('RELEASE SAVEPOINT retrieval_fallback');
    if (input.variant !== 'no_timeout_restore')
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [previous]);
    const scanned = r.rows[0]?.scanned ?? 0;
    // cap + 1 candidates means the permitted set was larger than the scan allows: not exact, so not used.
    if (scanned > tuning.fallbackRowCap) return { kind: 'fallback_cap' };
    return { kind: 'ok', ids: r.rows.map((x) => x.id) };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT retrieval_fallback');
    await client.query('RELEASE SAVEPOINT retrieval_fallback');
    if (isStatementTimeout(err)) return { kind: 'fallback_timeout' };
    throw err;
  }
}

async function hydrate(
  client: TenantClient,
  input: EngineInput,
  fused: Array<{ id: string; score: number }>,
): Promise<RetrievedChunk[]> {
  const r = await client.query<{
    id: string;
    content_id: string;
    content_version_id: string;
    kind: RetrievedChunk['kind'];
    locator: Record<string, unknown>;
    text: string;
  }>(
    `SELECT ch.id::text AS id, ch.content_id::text AS content_id, ch.content_version_id::text AS content_version_id,
            c.kind::text AS kind, ch.locator, left(ch.text, ${SNIPPET_CHARS * 2}) AS text
       FROM chunk ch JOIN content c ON c.org_id = ch.org_id AND c.id = ch.content_id
      WHERE ch.org_id = $1 AND ch.id = ANY($2::uuid[])`,
    [input.orgId, fused.map((f) => f.id)],
  );
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  const out: RetrievedChunk[] = [];
  for (const f of fused) {
    const row = byId.get(f.id);
    if (!row) continue;
    out.push({
      chunkId: row.id,
      contentId: row.content_id,
      versionId: row.content_version_id,
      kind: row.kind,
      locator: row.locator,
      snippet: snippetOf(row.text),
      score: Number(f.score.toFixed(6)),
    });
  }
  return out;
}

// eslint-disable-next-line no-control-regex
const SNIPPET_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function snippetOf(text: string): string {
  return Array.from(text.normalize('NFC').replace(SNIPPET_CONTROLS, ' '))
    .slice(0, SNIPPET_CHARS)
    .join('');
}
