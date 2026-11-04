// SPDX-License-Identifier: AGPL-3.0-only
// pg-boss schema bootstrap under least privilege (ADR-0001, code-inspection F6, verification N3).
// The platform role owns the pre-created `pgboss` schema but has no CREATE privilege on the database,
// and pg-boss's own migrate step issues CREATE SCHEMA IF NOT EXISTS, which Postgres privilege-checks
// against the database first. So the worker installs or upgrades the pg-boss objects itself from
// pg-boss's published plans (asking for them without the schema statement) and starts pg-boss with
// migrate: false.
//
// Plan shape (pg-boss 12): one transactional block `BEGIN; ... COMMIT;` that takes pg-boss's own
// advisory lock and bumps the version, optionally followed by statements that must run OUTSIDE any
// transaction (`CREATE INDEX CONCURRENTLY ...`). Sending the whole plan as one multi-statement query
// would run those trailing statements inside the implicit transaction block and fail, so the plan is
// split at its final COMMIT and the tail is executed one statement at a time.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getConstructionPlans, getMigrationPlans } from 'pg-boss';
import type pg from 'pg';

const SCHEMA_LINE_RE = /^\s*CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+[^;]*;\s*$/gim;
const COMMIT_LINE_RE = /^\s*COMMIT;\s*$/gm;
const BOOTSTRAP_LOCK_KEY = 7_201_262_002;

/** Defensive: strip a schema statement if a plan still carries one (createSchema:false should omit it). */
export function withoutSchemaStatement(plan: string): string {
  return plan.replace(SCHEMA_LINE_RE, '');
}

export interface SplitPlan {
  /** Everything up to and including the final `COMMIT;` (pg-boss manages this transaction itself). */
  transactional: string;
  /** Single statements that must run outside a transaction block, in order. */
  postCommit: string[];
}

/** Split a pg-boss plan into its transactional block and the trailing non-transactional statements. */
export function splitPlan(plan: string): SplitPlan {
  const cleaned = withoutSchemaStatement(plan);
  let lastCommitEnd = -1;
  for (const m of cleaned.matchAll(COMMIT_LINE_RE)) lastCommitEnd = m.index + m[0].length;
  if (lastCommitEnd < 0) return { transactional: cleaned, postCommit: [] };
  const transactional = cleaned.slice(0, lastCommitEnd);
  if (/CONCURRENTLY/i.test(transactional))
    throw new Error('pg-boss plan places a CONCURRENTLY statement inside its transaction block');
  const postCommit: string[] = [];
  let current: string[] = [];
  for (const rawLine of cleaned.slice(lastCommitEnd).split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('--')) continue;
    current.push(line);
    if (line.endsWith(';')) {
      postCommit.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) postCommit.push(current.join('\n'));
  return { transactional, postCommit };
}

/** pg-boss publishes its schema version in package.json (`pgboss.schema`); the dist bundle does not export it. */
export function targetSchemaVersion(): number {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve('pg-boss'));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        pgboss?: { schema?: number };
      };
      if (pkg.name === 'pg-boss' && typeof pkg.pgboss?.schema === 'number')
        return pkg.pgboss.schema;
    }
    dir = dirname(dir);
  }
  throw new Error('cannot determine the pg-boss schema version from its package.json');
}

async function runPlan(client: pg.PoolClient, plan: string): Promise<void> {
  const { transactional, postCommit } = splitPlan(plan);
  await client.query(transactional);
  for (const statement of postCommit) {
    try {
      await client.query(statement);
    } catch (err) {
      // The version bump is already committed, so a rerun reports `current`. Say exactly what is
      // missing so an operator can finish by hand (a failed CONCURRENTLY build leaves an INVALID index
      // that must be dropped first).
      throw new Error(
        `pg-boss post-migration statement failed; run it manually after dropping any INVALID index: ${statement}`,
        { cause: err },
      );
    }
  }
}

export async function ensureBossSchema(
  pool: pg.Pool,
  schema: string,
): Promise<'created' | 'migrated' | 'current'> {
  const client = await pool.connect();
  let failed = false;
  try {
    // Session-level lock (not transactional: the plans commit on their own) so concurrent worker
    // starts take turns; pg-boss's plan additionally guards the version row.
    await client.query('SELECT pg_advisory_lock($1)', [BOOTSTRAP_LOCK_KEY]);
    try {
      const hasVersion = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename = 'version'`,
        [schema],
      );
      if (hasVersion.rows[0]!.n === 0) {
        await runPlan(client, getConstructionPlans(schema, { createSchema: false }));
        return 'created';
      }
      const v = await client.query<{ version: number }>(`SELECT version FROM ${schema}.version`);
      const current = Number(v.rows[0]?.version ?? 0);
      // pg-boss asserts when asked for plans at the latest version, so compare with the version its
      // construction plan installs before requesting a migration.
      const target = targetSchemaVersion();
      if (current >= target) return 'current';
      await runPlan(client, getMigrationPlans(schema, current));
      return 'migrated';
    } catch (err) {
      failed = true;
      // A failure inside the plan's BEGIN block leaves the session in an aborted transaction; end it
      // so the unlock below cannot mask the real error with 25P02.
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [BOOTSTRAP_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    client.release(failed);
  }
}
