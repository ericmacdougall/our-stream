// SPDX-License-Identifier: AGPL-3.0-only
// M0-1: schema lint passes on the migrated schema; a deliberately unprotected table is caught.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { INTERNAL_ONLY_FUNCTIONS, lintSchema, PLATFORM_ONLY_FUNCTIONS } from './schema-lint.js';
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

  it('control: a SECURITY DEFINER function without an org guard or search_path pin is reported', async () => {
    await admin.query(
      `CREATE FUNCTION lint_control_unguarded() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
    );
    const findings = await lintSchema(adminUrl!);
    const problems = findings
      .filter((f) => f.object === 'lint_control_unguarded')
      .map((f) => f.problem);
    expect(problems.some((p) => p.includes('org guard'))).toBe(true);
    expect(problems.some((p) => p.includes('search_path'))).toBe(true);
    await admin.query('DROP FUNCTION lint_control_unguarded()');
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

  // ---- M2a (migration 0013) ----
  async function canExecute(role: string, fn: string): Promise<boolean[]> {
    const r = await admin.query<{ ok: boolean }>(
      `SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $2`,
      [role, fn],
    );
    return r.rows.map((x) => x.ok);
  }

  it('every platform-only function exists, is executable by the platform role and never by the app role', async () => {
    expect(PLATFORM_ONLY_FUNCTIONS.length).toBeGreaterThanOrEqual(20);
    for (const fn of PLATFORM_ONLY_FUNCTIONS) {
      const app = await canExecute('ourstream_app', fn);
      const platform = await canExecute('ourstream_platform', fn);
      expect(platform.length, `${fn} missing`).toBeGreaterThan(0);
      expect(
        app.every((x) => x === false),
        `${fn} app`,
      ).toBe(true);
      expect(
        platform.every((x) => x === true),
        `${fn} platform`,
      ).toBe(true);
    }
    for (const fn of INTERNAL_ONLY_FUNCTIONS) {
      expect(
        (await canExecute('ourstream_app', fn)).every((x) => x === false),
        fn,
      ).toBe(true);
      expect(
        (await canExecute('ourstream_platform', fn)).every((x) => x === false),
        fn,
      ).toBe(true);
    }
  });

  it('the app-facing M2a functions are executable by the app role', async () => {
    for (const fn of [
      'platform_documents_enabled',
      'platform_documents_kill_switch_engaged',
      'platform_embedding_active_pin',
      'document_upload_complete',
    ])
      expect(
        (await canExecute('ourstream_app', fn)).every((x) => x === true),
        fn,
      ).toBe(true);
  });

  it('control: granting a platform-only function to the app role is reported twice (allow-list and platform-only)', async () => {
    await admin.query(
      'GRANT EXECUTE ON FUNCTION platform_document_finish(uuid, uuid, uuid, jsonb) TO ourstream_app',
    );
    try {
      const findings = await lintSchema(adminUrl!);
      const problems = findings
        .filter((f) => f.object === 'platform_document_finish')
        .map((f) => f.problem);
      expect(problems).toContain('application role can execute a function outside the allow-list');
      expect(problems).toContain('application role can execute a platform-only function');
    } finally {
      await admin.query(
        'REVOKE EXECUTE ON FUNCTION platform_document_finish(uuid, uuid, uuid, jsonb) FROM ourstream_app',
      );
    }
    expect(
      (await lintSchema(adminUrl!)).filter((f) => f.object === 'platform_document_finish'),
    ).toEqual([]);
  });

  it('control: an app SELECT on the pin table or a write grant on embedding is reported', async () => {
    await admin.query('GRANT SELECT ON platform.embedding_pin TO ourstream_app');
    await admin.query('GRANT INSERT ON embedding TO ourstream_app');
    try {
      const findings = await lintSchema(adminUrl!);
      expect(findings).toContainEqual({
        object: 'platform.embedding_pin',
        problem: 'application role has direct privileges on a platform object',
      });
      expect(findings).toContainEqual({
        object: 'embedding',
        problem: 'application role can write a read-only table',
      });
    } finally {
      await admin.query('REVOKE SELECT ON platform.embedding_pin FROM ourstream_app');
      await admin.query('REVOKE INSERT ON embedding FROM ourstream_app');
    }
    expect(await lintSchema(adminUrl!)).toEqual([]);
  });

  it('embedding: the app role has SELECT only, RLS is enabled and forced, and the pin table is invisible to it', async () => {
    const r = await admin.query<{
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
      rls: boolean;
      frls: boolean;
      pin: boolean;
    }>(
      `SELECT has_table_privilege('ourstream_app', c.oid, 'SELECT') AS sel, has_table_privilege('ourstream_app', c.oid, 'INSERT') AS ins,
              has_table_privilege('ourstream_app', c.oid, 'UPDATE') AS upd, has_table_privilege('ourstream_app', c.oid, 'DELETE') AS del,
              c.relrowsecurity AS rls, c.relforcerowsecurity AS frls,
              has_table_privilege('ourstream_app', 'platform.embedding_pin', 'SELECT') AS pin
         FROM pg_class c WHERE c.oid = 'public.embedding'::regclass`,
    );
    expect(r.rows[0]).toEqual({
      sel: true,
      ins: false,
      upd: false,
      del: false,
      rls: true,
      frls: true,
      pin: false,
    });
  });
});
