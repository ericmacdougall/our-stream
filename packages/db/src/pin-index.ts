// SPDX-License-Identifier: AGPL-3.0-only
// Post-migrate embedding index job (M2a, AC-8). One HNSW index per pin, partial on the pin's literal id
// (an index predicate must be immutable), built with CREATE INDEX CONCURRENTLY, which cannot run inside the
// migration transaction. The job is idempotent: an existing valid index is left alone, an INVALID one (an
// interrupted concurrent build) is dropped and rebuilt, and readiness is reported to the platform pin
// table through platform_embedding_pin_ready. Names follow platform_embedding_pin_retire:
// embedding_hnsw_<first 8 hex digits of the pin id>.
import pg from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** pgvector 0.8.0 or later provides iterative index scans; below it retrieval must fail closed. */
export const MIN_PGVECTOR = [0, 8, 0] as const;

export function pinIndexName(pinId: string): string {
  if (!UUID_RE.test(pinId)) throw new Error('pinIndexName: pin id must be a UUID');
  return `embedding_hnsw_${pinId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

export function pgvectorAtLeast(version: string, min: readonly number[] = MIN_PGVECTOR): boolean {
  const parts = version
    .replace(/[^0-9.].*$/, '')
    .split('.')
    .map((p) => Number(p));
  if (parts.length === 0 || parts.some((p) => !Number.isInteger(p))) return false;
  for (let i = 0; i < min.length; i += 1) {
    const have = parts[i] ?? 0;
    if (have > min[i]!) return true;
    if (have < min[i]!) return false;
  }
  return true;
}

/** Startup check: throws unless the installed pgvector provides iterative scans. */
export async function assertPgvectorVersion(client: Pick<pg.Client, 'query'>): Promise<string> {
  const r = await client.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  const v = r.rows[0]?.extversion;
  if (!v) throw new Error('pgvector is not installed');
  if (!pgvectorAtLeast(v)) throw new Error(`pgvector ${v} is too old; 0.8.0 or later is required`);
  return v;
}

export interface PinIndexReport {
  pinId: string;
  index: string;
  action: 'created' | 'rebuilt' | 'kept';
  valid: boolean;
}

/**
 * Ensures the pin's HNSW index exists and is valid. `adminUrl` is the migration role (it owns the table);
 * the statements are not transactional. Never run two copies at once for one pin.
 */
export async function ensurePinIndex(adminUrl: string, pinId: string): Promise<PinIndexReport> {
  const index = pinIndexName(pinId);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await assertPgvectorVersion(client);
    const existing = await client.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`,
      [index],
    );
    let action: PinIndexReport['action'] = 'kept';
    if (existing.rows[0] && !existing.rows[0].valid) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${index}`);
      action = 'rebuilt';
    } else if (!existing.rows[0]) {
      action = 'created';
    }
    if (action !== 'kept') {
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON public.embedding USING hnsw (vector vector_cosine_ops) WHERE pin_id = '${pinId.toLowerCase()}'::uuid`,
      );
    }
    const after = await client.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
      [index],
    );
    return { pinId, index, action, valid: after.rows[0]?.valid === true };
  } finally {
    await client.end();
  }
}

/**
 * Checks per-org coverage by looping the org-required definer function over every org (never through
 * app-role reads) and writes the readiness row. Coverage is complete when no chunk hash of a current
 * version lacks a vector under the pin.
 */
export async function reportPinReadiness(
  platformUrl: string,
  pinId: string,
  indexValid: boolean,
): Promise<{ pinId: string; indexValid: boolean; coverageComplete: boolean; total: number; covered: number }> {
  if (!UUID_RE.test(pinId)) throw new Error('reportPinReadiness: pin id must be a UUID');
  const client = new pg.Client({ connectionString: platformUrl });
  await client.connect();
  try {
    const orgs = await client.query<{ id: string }>('SELECT platform_orgs() AS id');
    let total = 0;
    let covered = 0;
    for (const o of orgs.rows) {
      const r = await client.query<{ total: string; covered: string }>(
        'SELECT total, covered FROM platform_embedding_coverage($1, $2)',
        [o.id, pinId],
      );
      total += Number(r.rows[0]?.total ?? 0);
      covered += Number(r.rows[0]?.covered ?? 0);
    }
    const coverageComplete = covered >= total;
    await client.query('SELECT platform_embedding_pin_ready($1, $2, $3)', [pinId, indexValid, coverageComplete]);
    return { pinId, indexValid, coverageComplete, total, covered };
  } finally {
    await client.end();
  }
}
