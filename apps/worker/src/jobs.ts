// SPDX-License-Identifier: AGPL-3.0-only
// Job registry. Every tenant job carries org_id and runs inside withTenant (ADR-0001 §1c).
// Platform jobs (outbox drain) run under the platform role and only dispatch per-org work.
import type pg from 'pg';
import { withTenant } from '@our-stream/db';
import { z } from 'zod';

export const TenantJob = z.object({ orgId: z.uuid() });

export interface JobContext {
  tenantPool: pg.Pool;
  platformPool: pg.Pool;
  log: { info: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void };
}

export type Handler = (data: unknown, ctx: JobContext) => Promise<void>;

/** Drains platform.domain_event in id order; marks processed. Fan-out rules arrive with M1a. */
export const outboxDrain: Handler = async (_data, ctx) => {
  const client = await ctx.platformPool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{ id: string; org_id: string; type: string }>(
      'SELECT id, org_id, type FROM platform.domain_event WHERE processed_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED',
    );
    for (const ev of r.rows) {
      ctx.log.info({ eventId: ev.id, orgId: ev.org_id, type: ev.type }, 'outbox event');
      await client.query('UPDATE platform.domain_event SET processed_at = now() WHERE id = $1', [
        ev.id,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/** Example tenant job proving the tenant context contract; real pipeline jobs arrive with M1a. */
export const tenantPing: Handler = async (data, ctx) => {
  const { orgId } = TenantJob.parse(data);
  await withTenant(ctx.tenantPool, { orgId, userId: null }, async (client) => {
    const r = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM content');
    ctx.log.info({ orgId, content: r.rows[0]?.n ?? 0 }, 'tenant ping');
  });
};

export const handlers: Record<string, Handler> = {
  'platform.outbox.drain': outboxDrain,
  'tenant.ping': tenantPing,
};
