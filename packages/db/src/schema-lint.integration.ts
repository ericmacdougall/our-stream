// SPDX-License-Identifier: AGPL-3.0-only
// M0-1: schema lint passes on the migrated schema; a deliberately unprotected table is caught.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { lintSchema } from './schema-lint.js';
import { runMigrations } from './migrate.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];

describe.skipIf(!adminUrl)('schema lint (integration)', () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  beforeAll(async () => {
    await runMigrations(adminUrl!);
    await admin.connect();
  });
  afterAll(async () => {
    await admin.query('DROP TABLE IF EXISTS lint_control_unprotected');
    await admin.end();
  });

  it('reports zero findings on the migrated schema', async () => {
    const findings = await lintSchema(adminUrl!);
    expect(findings).toEqual([]);
  });

  it('control: a tenant table without org_id, RLS or policy is reported', async () => {
    await admin.query(
      'CREATE TABLE lint_control_unprotected (id uuid PRIMARY KEY DEFAULT gen_random_uuid())',
    );
    const findings = await lintSchema(adminUrl!);
    const problems = findings
      .filter((f) => f.object.startsWith('lint_control_unprotected'))
      .map((f) => f.problem);
    expect(problems).toContain('missing org_id column');
    expect(problems).toContain('row level security not enabled');
    expect(problems).toContain('no RLS policy');
    await admin.query('DROP TABLE lint_control_unprotected');
  });
});
