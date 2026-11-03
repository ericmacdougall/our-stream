// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { tenantPing } from './jobs.js';

describe('tenant jobs', () => {
  it('refuses a job without a valid org id before touching the database', async () => {
    const pool = {
      connect: () => Promise.reject(new Error('must not connect')),
    } as unknown as pg.Pool;
    const ctx = {
      tenantPool: pool,
      platformPool: pool,
      log: { info: () => undefined, error: () => undefined },
    };
    await expect(tenantPing({ orgId: 'not-a-uuid' }, ctx)).rejects.toThrow();
    await expect(tenantPing({}, ctx)).rejects.toThrow();
  });
});
