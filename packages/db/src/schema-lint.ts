// SPDX-License-Identifier: AGPL-3.0-only
// Schema lint (ADR-0001, ADR-0012): every tenant table (including partitioned parents) has org_id, RLS
// enabled and forced, a policy with USING and WITH CHECK on app_org(); every trigger/definer function
// carries an explicit org guard and definer functions pin search_path; no materialised views in the
// tenant schema; the app role cannot bypass RLS, owns nothing, has no privileges on platform tables or
// per-org sequences, and cannot execute maintenance functions.
import pg from 'pg';

export interface LintFinding {
  object: string;
  problem: string;
}

const APP_ALLOWED_PLATFORM_OBJECTS = new Set<string>([]);
const APP_ALLOWED_FUNCTIONS = new Set([
  'app_org',
  'app_user',
  'next_org_content_epoch',
  'current_org_content_epoch',
  'authz_users_in_group',
  'authz_groups_of_user',
  'platform_emit_event',
  'org_epoch_seq_name',
  // M1a definer functions (migration 0002)
  'content_publish',
  'content_retract',
  'record_view',
  'platform_account_create',
  'platform_account_by_email',
  'platform_account_get',
  'platform_session_create',
  'platform_session_lookup',
  'platform_session_revoke',
  'platform_session_switch_org',
  'platform_magic_link_create',
  'platform_magic_link_consume',
  'platform_memberships_of',
  'platform_org_create',
  'platform_invite_accept',
  'platform_account_set_password_if_unset',
]);

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
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
    );
    for (const t of tables.rows) {
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

    const tenantTableNames = tables.rows.map((t) => t.relname).filter((n) => n !== 'org');

    const matviews = await client.query<{ matviewname: string }>(
      `SELECT matviewname FROM pg_matviews WHERE schemaname = 'public'`,
    );
    for (const m of matviews.rows)
      findings.push({
        object: m.matviewname,
        problem: 'materialised view in tenant schema (cannot carry RLS)',
      });

    const fns = await client.query<{
      proname: string;
      prosrc: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      is_trigger: boolean;
    }>(
      `SELECT p.proname, p.prosrc, p.prosecdef, p.proconfig, p.prorettype = 'trigger'::regtype AS is_trigger
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.prosecdef OR p.prorettype = 'trigger'::regtype)
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`,
    );
    for (const f of fns.rows) {
      // Guard detection is textual by design: it enforces that every such function states its org
      // precondition explicitly; the fixture matrix proves the behaviour.
      // Convention: a tenant-touching function raises "...org required" / "...org context"; a platform-scope
      // function declares itself with "platform-scope" and may not reference any tenant table.
      const orgGuard = /RAISE EXCEPTION '[^']*(org required|org context|cross-org by design)/i.test(
        f.prosrc,
      );
      const platformScope = /RAISE EXCEPTION '[^']*platform-scope/i.test(f.prosrc);
      if (!orgGuard && !platformScope) {
        findings.push({
          object: f.proname,
          problem:
            'trigger/definer function has no explicit org guard or platform-scope declaration',
        });
      }
      if (platformScope && !orgGuard) {
        const touched = tenantTableNames.filter((t) =>
          new RegExp(`\\b${t}\\b`, 'i').test(f.prosrc),
        );
        if (touched.length > 0)
          findings.push({
            object: f.proname,
            problem: `platform-scope function references tenant tables: ${touched.join(', ')}`,
          });
      }
      if (f.prosecdef && !(f.proconfig ?? []).some((c) => c.startsWith('search_path='))) {
        findings.push({
          object: f.proname,
          problem: 'SECURITY DEFINER function does not pin search_path',
        });
      }
    }

    const role = await client.query<{
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `SELECT rolbypassrls, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1`,
      [appRole],
    );
    const r = role.rows[0];
    if (!r) findings.push({ object: appRole, problem: 'application role does not exist' });
    else if (r.rolbypassrls || r.rolsuper || r.rolcreatedb || r.rolcreaterole)
      findings.push({ object: appRole, problem: 'application role has elevated attributes' });

    const owned = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname IN ('public', 'platform') AND c.relkind IN ('r', 'p', 'S', 'v', 'm') AND r.rolname = $1`,
      [appRole],
    );
    for (const o of owned.rows)
      findings.push({ object: o.relname, problem: 'object owned by the application role' });

    // SECURITY DEFINER functions read FORCE-RLS tables as the table owner, so the owner must bypass RLS
    // (superuser or BYPASSRLS); otherwise login, invites and fan-out silently return nothing.
    const owners = await client.query<{ rolname: string; ok: boolean }>(
      `SELECT DISTINCT r.rolname, (r.rolbypassrls OR r.rolsuper) AS ok FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    for (const o of owners.rows) {
      if (!o.ok) findings.push({ object: o.rolname, problem: 'tenant table owner cannot bypass RLS; SECURITY DEFINER functions would see no rows' });
    }

    // Platform schema: the app role gets no table or sequence privileges there (definer functions mediate).
    const platformPrivs = await client.query<{ relname: string; relkind: string }>(
      `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'platform' AND c.relkind IN ('r', 'p', 'S', 'v')
         AND (
           (c.relkind IN ('r','p','v') AND (has_table_privilege($1, c.oid, 'SELECT') OR has_table_privilege($1, c.oid, 'INSERT')
             OR has_table_privilege($1, c.oid, 'UPDATE') OR has_table_privilege($1, c.oid, 'DELETE')))
           OR (c.relkind = 'S' AND (has_sequence_privilege($1, c.oid, 'SELECT') OR has_sequence_privilege($1, c.oid, 'USAGE') OR has_sequence_privilege($1, c.oid, 'UPDATE')))
         )`,
      [appRole],
    );
    for (const p of platformPrivs.rows) {
      if (!APP_ALLOWED_PLATFORM_OBJECTS.has(p.relname))
        findings.push({
          object: `platform.${p.relname}`,
          problem: 'application role has direct privileges on a platform object',
        });
    }

    // Function execution: the app role may execute only the allow-listed public functions.
    const execs = await client.query<{ proname: string }>(
      `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND has_function_privilege($1, p.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`,
      [appRole],
    );
    for (const e of execs.rows) {
      if (!APP_ALLOWED_FUNCTIONS.has(e.proname))
        findings.push({
          object: e.proname,
          problem: 'application role can execute a function outside the allow-list',
        });
    }
  } finally {
    await client.end();
  }
  return findings;
}
