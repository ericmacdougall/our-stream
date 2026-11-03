// SPDX-License-Identifier: AGPL-3.0-only
// Schema lint (ADR-0001): every tenant table has org_id, RLS enabled and forced, a policy with both
// USING and WITH CHECK; every trigger/definer function in public filters by org (static check on
// source for an org guard); no materialised views in the tenant schema; app role has no BYPASSRLS.
import pg from 'pg';

export interface LintFinding {
  object: string;
  problem: string;
}

const PLATFORM_ONLY_TABLES = new Set<string>([]);

export async function lintSchema(
  adminUrl: string,
  appRole = 'ourstream_app',
): Promise<LintFinding[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const findings: LintFinding[] = [];
  try {
    const tables = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    );
    for (const t of tables.rows) {
      if (PLATFORM_ONLY_TABLES.has(t.relname)) continue;
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [t.relname],
      );
      if (!cols.rows.some((c) => c.column_name === 'org_id'))
        findings.push({ object: t.relname, problem: 'missing org_id column' });
      if (!t.relrowsecurity)
        findings.push({ object: t.relname, problem: 'row level security not enabled' });
      if (!t.relforcerowsecurity)
        findings.push({ object: t.relname, problem: 'row level security not forced' });
      const policies = await client.query<{
        polname: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT polname, pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS with_check
         FROM pg_policy WHERE polrelid = ('public.' || quote_ident($1))::regclass`,
        [t.relname],
      );
      if (policies.rows.length === 0)
        findings.push({ object: t.relname, problem: 'no RLS policy' });
      for (const p of policies.rows) {
        if (!p.qual || !p.qual.includes('app_org()'))
          findings.push({
            object: `${t.relname}.${p.polname}`,
            problem: 'policy USING does not reference app_org()',
          });
        if (!p.with_check || !p.with_check.includes('app_org()'))
          findings.push({
            object: `${t.relname}.${p.polname}`,
            problem: 'policy lacks WITH CHECK referencing app_org()',
          });
      }
    }

    const matviews = await client.query<{ matviewname: string }>(
      `SELECT matviewname FROM pg_matviews WHERE schemaname = 'public'`,
    );
    for (const m of matviews.rows)
      findings.push({
        object: m.matviewname,
        problem: 'materialised view in tenant schema (cannot carry RLS)',
      });

    const fns = await client.query<{ proname: string; prosrc: string; prosecdef: boolean }>(
      `SELECT p.proname, p.prosrc, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.prosecdef OR p.prorettype = 'trigger'::regtype)`,
    );
    for (const f of fns.rows) {
      const guarded =
        /org_id\s+IS\s+NULL|p_org\s+IS\s+NULL|org required|org context mismatch/i.test(f.prosrc);
      if (!guarded)
        findings.push({
          object: f.proname,
          problem: 'trigger/definer function has no explicit org guard',
        });
    }

    const role = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`,
      [appRole],
    );
    const r = role.rows[0];
    if (!r) findings.push({ object: appRole, problem: 'application role does not exist' });
    else if (r.rolbypassrls || r.rolsuper)
      findings.push({ object: appRole, problem: 'application role can bypass RLS' });

    const owned = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = $1`,
      [appRole],
    );
    for (const o of owned.rows)
      findings.push({ object: o.relname, problem: 'tenant table owned by the application role' });
  } finally {
    await client.end();
  }
  return findings;
}
