// SPDX-License-Identifier: AGPL-3.0-only
// Request-scoped tenant context (ADR-0001). Every tenant query runs inside withTenant(), which opens
// a transaction and sets app.org_id / app.user_id with transaction-scoped set_config (safe behind
// transaction pooling). Raw pool access outside this helper is a programming error; a lint rule and
// runtime guard for that are tracked for M1a (not yet implemented).
import pg from 'pg';

export interface TenantContext {
  orgId: string;
  userId: string | null;
}

export type TenantClient = pg.PoolClient & { readonly tenant: TenantContext };

/** The epochs a cache key is built from (ADR-0004). */
export interface EpochReads {
  authzEpoch: number;
  orgContentEpoch: number;
  active: boolean;
}

/**
 * Result of the epoch pre-read and post-read around a REPEATABLE READ request. `stable` is true only when
 * both reads succeeded and agree; a result computed under an unstable pair is returned but never cached.
 * `after` is null when the post-read failed (treated as unstable).
 */
export interface EpochCheck {
  before: EpochReads;
  after: EpochReads | null;
  stable: boolean;
}

export type TenantPhase = 'pre-read-done' | 'snapshot-started' | 'committed';

export interface WithTenantOptions {
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ';
  /**
   * Epoch pre/post-read mode (ADR-0004; M2a snapshot semantics). The sequence-backed org content epoch is
   * not MVCC and `current_org_content_epoch` needs the tenant context, so the epochs are read in their own
   * short READ COMMITTED transactions on the same connection: one BEFORE the request transaction opens, one
   * after it COMMITs (inside a REPEATABLE READ snapshot the MVCC `authz_epoch` would return the old value
   * and hide a change). The pre-read values are passed to `fn`; the comparison goes to this callback.
   */
  onEpochCheck?: (check: EpochCheck) => void;
  /** Test seam: awaited at the named points so a test can commit a change between phases. */
  testHooks?: { onPhase?: (phase: TenantPhase) => Promise<void> };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {}

export function createPool(
  connectionString: string,
  options: Partial<pg.PoolConfig> = {},
): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, ...options });
}

/**
 * Runs `fn` inside a transaction with the tenant context set. Both ids are validated as UUIDs before
 * any query runs, so the literal interpolation below cannot carry anything else. On any failure the
 * transaction is rolled back; if the rollback itself fails the connection is destroyed, never reused.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (client: TenantClient, epochs: EpochReads | undefined) => Promise<T>,
  opts: WithTenantOptions = {},
): Promise<T> {
  if (!UUID_RE.test(ctx.orgId)) throw new TenantContextError('withTenant: orgId must be a UUID');
  if (ctx.userId !== null && !UUID_RE.test(ctx.userId))
    throw new TenantContextError('withTenant: userId must be a UUID or null');
  const client = await pool.connect();
  let destroy = false;
  const setContext = `SELECT set_config('app.org_id', '${ctx.orgId}', true), set_config('app.user_id', '${ctx.userId ?? ''}', true)`;
  try {
    let before: EpochReads | undefined;
    if (opts.onEpochCheck) {
      before = await readEpochsShortTx(client, ctx, setContext);
      await opts.testHooks?.onPhase?.('pre-read-done');
    }
    await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
    await client.query(setContext); // the first statement takes the REPEATABLE READ snapshot
    await opts.testHooks?.onPhase?.('snapshot-started');
    const tenantClient = Object.assign(client, {
      tenant: Object.freeze({ ...ctx }),
    }) as TenantClient;
    const result = await fn(tenantClient, before);
    await client.query('COMMIT');
    await opts.testHooks?.onPhase?.('committed');
    if (opts.onEpochCheck && before) {
      let after: EpochReads | null = null;
      try {
        after = await readEpochsShortTx(client, ctx, setContext);
      } catch {
        after = null; // the request already committed; an unreadable post-read only makes the pair unstable
      }
      opts.onEpochCheck({
        before,
        after,
        stable:
          after !== null &&
          after.authzEpoch === before.authzEpoch &&
          after.orgContentEpoch === before.orgContentEpoch &&
          after.active === before.active,
      });
    }
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    throw err;
  } finally {
    Reflect.deleteProperty(client, 'tenant'); // never leak the context to the next pool user
    client.release(destroy ? new Error('connection discarded after failed rollback') : undefined);
  }
}

async function readEpochsOnce(
  client: pg.PoolClient,
  orgId: string,
  userId: string | null,
): Promise<EpochReads> {
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

/** A short READ COMMITTED transaction with the transaction-local tenant context: read both epochs, commit. */
async function readEpochsShortTx(
  client: pg.PoolClient,
  ctx: TenantContext,
  setContext: string,
): Promise<EpochReads> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await client.query(setContext);
    const r = await readEpochsOnce(client, ctx.orgId, ctx.userId);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Reads the caller's epochs inside the tenant transaction. Callers must read these before the query
 * they key (ADR-0004 key-read ordering invariant) under the default READ COMMITTED isolation: sequence
 * reads are not MVCC, so under REPEATABLE READ the epoch could be newer than the snapshot the query sees.
 */
export async function readEpochs(client: TenantClient): Promise<EpochReads> {
  return readEpochsOnce(client, client.tenant.orgId, client.tenant.userId);
}
