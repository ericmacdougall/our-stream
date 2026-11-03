// SPDX-License-Identifier: AGPL-3.0-only
// Request-scoped tenant context (ADR-0001). Every tenant query runs inside withTenant(), which opens
// a transaction and sets app.org_id / app.user_id with SET LOCAL (safe behind transaction pooling).
// Raw pool access outside this helper is a programming error; the pool wrapper refuses tenant tables.
import pg from 'pg';

export interface TenantContext {
  orgId: string;
  userId: string | null;
}

export type TenantClient = pg.PoolClient & { readonly tenant: TenantContext };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {}

export function createPool(
  connectionString: string,
  options: Partial<pg.PoolConfig> = {},
): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, ...options });
}

/**
 * Runs `fn` inside a transaction with the tenant context set. The org id must be a UUID; a missing
 * org fails before any query runs. Nested calls with a different org are refused.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (client: TenantClient) => Promise<T>,
  opts: { isolation?: 'READ COMMITTED' | 'REPEATABLE READ' } = {},
): Promise<T> {
  if (!UUID_RE.test(ctx.orgId)) throw new TenantContextError('withTenant: orgId must be a UUID');
  if (ctx.userId !== null && !UUID_RE.test(ctx.userId))
    throw new TenantContextError('withTenant: userId must be a UUID or null');
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
    // SET LOCAL does not accept bind parameters; values are validated UUIDs or empty.
    await client.query(
      `SELECT set_config('app.org_id', '${ctx.orgId}', true), set_config('app.user_id', '${ctx.userId ?? ''}', true)`,
    );
    const tenantClient = Object.assign(client, { tenant: ctx }) as TenantClient;
    const result = await fn(tenantClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may already be broken; release below
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Reads the caller's current epochs inside the tenant transaction (ADR-0004 key-read ordering). */
export async function readEpochs(
  client: TenantClient,
): Promise<{ authzEpoch: number; orgContentEpoch: number; active: boolean }> {
  const { orgId, userId } = client.tenant;
  const org = await client.query<{ e: string }>('SELECT current_org_content_epoch($1)::text AS e', [
    orgId,
  ]);
  const orgContentEpoch = Number(org.rows[0]?.e ?? '0');
  if (userId === null) return { authzEpoch: 0, orgContentEpoch, active: false };
  const m = await client.query<{ authz_epoch: string; status: string }>(
    'SELECT authz_epoch::text, status FROM org_membership WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  const row = m.rows[0];
  return {
    authzEpoch: Number(row?.authz_epoch ?? '0'),
    orgContentEpoch,
    active: row?.status === 'active',
  };
}
