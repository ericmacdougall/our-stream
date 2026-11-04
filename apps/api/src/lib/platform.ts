// SPDX-License-Identifier: AGPL-3.0-only
// Account, session, magic-link and org-bootstrap access for the app role. The role has no privileges on
// platform tables (ADR-0001); every call here goes through a SECURITY DEFINER function from migration
// 0002. These calls carry no tenant context by design (they are platform-scope); tenant tables are only
// touched inside withTenant().
import type pg from 'pg';

export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export type OrgRole = 'owner' | 'admin' | 'announcer' | 'contributor' | 'member' | 'auditor';
export type MembershipStatus = 'active' | 'deactivated';

export interface Account {
  id: string;
  email: string;
  displayName: string;
}

export interface MembershipRow {
  orgId: string;
  slug: string;
  name: string;
  role: OrgRole;
  status: MembershipStatus;
}

/** A transaction without tenant context, for sequences of platform-scope calls that must be atomic. */
export async function withPlatform<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    throw err;
  } finally {
    client.release(destroy ? new Error('connection discarded after failed rollback') : undefined);
  }
}

/** F3: adopt an invited, password-less account at signup; false when a password already exists. */
export async function accountSetPasswordIfUnset(client: Queryable, id: string, passwordHash: string): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>('SELECT platform_account_set_password_if_unset($1, $2) AS ok', [id, passwordHash]);
  return r.rows[0]?.ok === true;
}

export async function accountByEmail(
  q: Queryable,
  emailNormalized: string,
): Promise<(Account & { passwordHash: string | null }) | null> {
  const r = await q.query<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string | null;
  }>('SELECT id, email, display_name, password_hash FROM platform_account_by_email($1)', [
    emailNormalized,
  ]);
  const row = r.rows[0];
  return row
    ? {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        passwordHash: row.password_hash,
      }
    : null;
}

export async function accountGet(q: Queryable, id: string): Promise<Account | null> {
  const r = await q.query<{ id: string; email: string; display_name: string }>(
    'SELECT id, email, display_name FROM platform_account_get($1)',
    [id],
  );
  const row = r.rows[0];
  return row ? { id: row.id, email: row.email, displayName: row.display_name } : null;
}

export async function accountCreate(
  q: Queryable,
  email: string,
  emailNormalized: string,
  displayName: string,
  passwordHash: string | null,
): Promise<string> {
  const r = await q.query<{ id: string }>('SELECT platform_account_create($1, $2, $3, $4) AS id', [
    email,
    emailNormalized,
    displayName,
    passwordHash,
  ]);
  return r.rows[0]!.id;
}

export async function sessionCreate(
  q: Queryable,
  userId: string,
  orgId: string | null,
  tokenHash: Buffer,
  ttlDays: number,
): Promise<string> {
  const r = await q.query<{ id: string }>(
    `SELECT platform_session_create($1, $2, $3, make_interval(days => $4::int)) AS id`,
    [userId, orgId, tokenHash, ttlDays],
  );
  return r.rows[0]!.id;
}

export interface SessionRow {
  sessionId: string;
  userId: string;
  orgId: string | null;
  expiresAt: Date;
}

export async function sessionLookup(q: Queryable, tokenHash: Buffer): Promise<SessionRow | null> {
  const r = await q.query<{
    session_id: string;
    user_id: string;
    org_id: string | null;
    expires_at: Date;
  }>('SELECT session_id, user_id, org_id, expires_at FROM platform_session_lookup($1)', [
    tokenHash,
  ]);
  const row = r.rows[0];
  return row
    ? {
        sessionId: row.session_id,
        userId: row.user_id,
        orgId: row.org_id,
        expiresAt: row.expires_at,
      }
    : null;
}

export async function sessionRevoke(q: Queryable, tokenHash: Buffer): Promise<void> {
  await q.query('SELECT platform_session_revoke($1)', [tokenHash]);
}

export async function sessionSwitchOrg(
  q: Queryable,
  tokenHash: Buffer,
  orgId: string,
): Promise<boolean> {
  const r = await q.query<{ ok: boolean }>('SELECT platform_session_switch_org($1, $2) AS ok', [
    tokenHash,
    orgId,
  ]);
  return r.rows[0]?.ok === true;
}

export async function magicLinkCreate(
  q: Queryable,
  userId: string,
  tokenHash: Buffer,
  purpose: 'login' | 'invite',
  orgId: string | null,
  ttlMinutes: number,
): Promise<void> {
  await q.query(
    'SELECT platform_magic_link_create($1, $2, $3, $4, make_interval(mins => $5::int))',
    [userId, tokenHash, purpose, orgId, ttlMinutes],
  );
}

export async function magicLinkConsume(
  q: Queryable,
  tokenHash: Buffer,
): Promise<{
  userId: string;
  purpose: 'login' | 'invite' | 'verify';
  orgId: string | null;
} | null> {
  const r = await q.query<{
    user_id: string;
    purpose: 'login' | 'invite' | 'verify';
    org_id: string | null;
  }>('SELECT user_id, purpose, org_id FROM platform_magic_link_consume($1)', [tokenHash]);
  const row = r.rows[0];
  return row ? { userId: row.user_id, purpose: row.purpose, orgId: row.org_id } : null;
}

export async function membershipsOf(q: Queryable, userId: string): Promise<MembershipRow[]> {
  const r = await q.query<{
    org_id: string;
    slug: string;
    name: string;
    role: OrgRole;
    status: MembershipStatus;
  }>('SELECT org_id, slug, name, role, status FROM platform_memberships_of($1) ORDER BY name', [
    userId,
  ]);
  return r.rows.map((m) => ({
    orgId: m.org_id,
    slug: m.slug,
    name: m.name,
    role: m.role,
    status: m.status,
  }));
}

export async function orgCreate(
  q: Queryable,
  userId: string,
  slug: string,
  name: string,
): Promise<string> {
  const r = await q.query<{ id: string }>('SELECT platform_org_create($1, $2, $3) AS id', [
    userId,
    slug,
    name,
  ]);
  return r.rows[0]!.id;
}

export async function inviteAccept(
  q: Queryable,
  userId: string,
  emailNormalized: string,
  orgId: string,
): Promise<boolean> {
  const r = await q.query<{ ok: boolean }>('SELECT platform_invite_accept($1, $2, $3) AS ok', [
    userId,
    emailNormalized,
    orgId,
  ]);
  return r.rows[0]?.ok === true;
}
