// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { handlers, QUEUES, tenantPing, type JobContext } from './jobs.js';

describe('tenant jobs', () => {
  it('refuses a job without a valid org id before touching the database', async () => {
    const pool = {
      connect: () => Promise.reject(new Error('must not connect')),
    } as unknown as pg.Pool;
    const ctx = {
      tenantPool: pool,
      platformPool: pool,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as JobContext;
    await expect(tenantPing({ orgId: 'not-a-uuid' }, ctx)).rejects.toThrow();
    await expect(tenantPing({}, ctx)).rejects.toThrow();
  });
  it('registers every queue the outbox dispatches to', () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.values(QUEUES).sort());
  });
});
