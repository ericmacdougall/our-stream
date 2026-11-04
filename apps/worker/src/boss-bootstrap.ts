// SPDX-License-Identifier: AGPL-3.0-only
// pg-boss schema bootstrap under least privilege (ADR-0001, code-inspection F6).
// The platform role owns the pre-created `pgboss` schema but has no CREATE privilege on the database,
// and pg-boss's own migrate step always issues CREATE SCHEMA IF NOT EXISTS, which Postgres
// privilege-checks against the database first. So the worker installs or upgrades the pg-boss objects
// itself from pg-boss's published plans, skipping the schema statement, and starts pg-boss with
// migrate: false.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getConstructionPlans, getMigrationPlans } from 'pg-boss';
import type pg from 'pg';

const SCHEMA_LINE_RE = /^\s*CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+[^;]*;\s*$/gim;

/** pg-boss plans are multi-statement SQL; strip only the schema statement and run the rest as one query. */
export function withoutSchemaStatement(plan: string): string {
  return plan.replace(SCHEMA_LINE_RE, '');
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

export async function ensureBossSchema(
  pool: pg.Pool,
  schema: string,
): Promise<'created' | 'migrated' | 'current'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [7_201_262_002]);
    const hasVersion = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1 AND tablename = 'version'`,
      [schema],
    );
    let result: 'created' | 'migrated' | 'current';
    if (hasVersion.rows[0]!.n === 0) {
      await client.query(withoutSchemaStatement(getConstructionPlans(schema)));
      result = 'created';
    } else {
      const v = await client.query<{ version: number }>(`SELECT version FROM ${schema}.version`);
      const current = Number(v.rows[0]?.version ?? 0);
      // pg-boss asserts when asked for plans at the latest version, so compare with the version its
      // construction plan installs before requesting a migration.
      const target = targetSchemaVersion();
      if (current < target) {
        await client.query(withoutSchemaStatement(getMigrationPlans(schema, current)));
        result = 'migrated';
      } else {
        result = 'current';
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
