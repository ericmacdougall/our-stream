// SPDX-License-Identifier: AGPL-3.0-only
// pg-boss bootstrap against a real Postgres as the platform role (verification N3): install from
// scratch into a pre-created schema, no-op when current, and upgrade from the previous schema version
// with pg-boss's own rollback plan as the downgrade. The failing control sends the raw migration plan
// as one query, which Postgres refuses because CREATE INDEX CONCURRENTLY cannot run inside the
// implicit transaction block of a multi-statement query.
import { randomBytes } from 'node:crypto';
import { getMigrationPlans } from 'pg-boss';
import { rollback } from 'pg-boss/dist/migrationStore.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureBossSchema,
  splitPlan,
  targetSchemaVersion,
  withoutSchemaStatement,
} from './boss-bootstrap.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL'];

describe.skipIf(!(adminUrl && platformUrl))('pg-boss bootstrap (integration)', () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const platform = new pg.Pool({ connectionString: platformUrl, max: 2 });
  const schema = `pgboss_bt_${randomBytes(3).toString('hex')}`;
  const target = targetSchemaVersion();
  const previous = target - 1;

  const version = async () =>
    Number(
      (await admin.query<{ version: number }>(`SELECT version FROM ${schema}.version`)).rows[0]!
        .version,
    );
  const indexNames = () =>
    splitPlan(getMigrationPlans(schema, previous)).postCommit.map(
      (s) => /IF NOT EXISTS (\w+)/.exec(s)![1]!,
    );
  const presentIndexes = async () =>
    (
      await admin.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2)`,
        [schema, indexNames()],
      )
    ).rows.map((r) => r.indexname);
  const downgrade = async () => {
    await admin.query(rollback(schema, target));
    // Make the upgrade's post-commit index builds observable even if the rollback left them behind.
    for (const name of indexNames()) await admin.query(`DROP INDEX IF EXISTS ${schema}.${name}`);
    expect(await version()).toBe(previous);
    expect(await presentIndexes()).toEqual([]);
  };

  beforeAll(async () => {
    const role = (await platform.query<{ r: string }>('SELECT current_user AS r')).rows[0]!.r;
    await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION "${role}"`);
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await platform.end();
  });

  it('installs into the pre-created schema as the platform role, then reports current', async () => {
    expect(await ensureBossSchema(platform, schema)).toBe('created');
    expect(await version()).toBe(target);
    expect(await ensureBossSchema(platform, schema)).toBe('current');
  });

  it('control: the raw migration plan sent as one query fails on CREATE INDEX CONCURRENTLY', async () => {
    await downgrade();
    await expect(
      platform.query(withoutSchemaStatement(getMigrationPlans(schema, previous))),
    ).rejects.toThrow(/transaction block/);
  });

  it('upgrades from the previous schema version with the concurrent index builds applied', async () => {
    await downgrade();
    expect(await ensureBossSchema(platform, schema)).toBe('migrated');
    expect(await version()).toBe(target);
    expect((await presentIndexes()).sort()).toEqual(indexNames().sort());
    expect(await ensureBossSchema(platform, schema)).toBe('current');
  });
});
