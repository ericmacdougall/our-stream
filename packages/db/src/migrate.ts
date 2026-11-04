// SPDX-License-Identifier: AGPL-3.0-only
// Forward-only SQL migration runner (ADR-0012). All pending files run in one transaction, in order, as
// the migration (owner) role; checksums guard against edited history; an advisory lock serialises
// concurrent runners including first-time bootstrap; files may not contain transaction control.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const migrationsDir = join(here, '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const TXN_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\b/im;
const LOCK_KEY = 7_201_262_001; // arbitrary, stable: "our-stream migrations"

export async function runMigrations(
  adminUrl: string,
  dir = migrationsDir,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      await client.query('CREATE SCHEMA IF NOT EXISTS platform');
      await client.query(
        'CREATE TABLE IF NOT EXISTS platform.schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text NOT NULL)',
      );
      const done = await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM platform.schema_migration',
      );
      const doneMap = new Map(done.rows.map((r) => [r.name, r.checksum]));
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files) {
        const sql = readFileSync(join(dir, file), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const prior = doneMap.get(file);
        if (prior !== undefined) {
          if (prior !== checksum)
            throw new Error(
              `migration ${file} was modified after being applied (checksum mismatch)`,
            );
          skipped.push(file);
          continue;
        }
        // Function bodies are dollar-quoted and legitimately contain BEGIN/END; only top-level statements count.
        if (TXN_CONTROL.test(sql.replace(/\$[A-Za-z_]*\$[\s\S]*?\$[A-Za-z_]*\$/g, ''))) {
          throw new Error(
            `migration ${file} contains transaction control; the runner owns the transaction`,
          );
        }
        try {
          await client.query(sql);
        } catch (err) {
          throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
        await client.query(
          'INSERT INTO platform.schema_migration (name, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        applied.push(file);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
  return { applied, skipped };
}
