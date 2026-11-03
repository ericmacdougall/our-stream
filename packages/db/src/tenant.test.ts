// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { TenantContextError, withTenant } from './tenant.js';

describe('withTenant input validation', () => {
  const neverConnect = {
    connect: () => Promise.reject(new Error('should not connect')),
  } as unknown as pg.Pool;

  it('refuses a non-UUID org id before touching the pool', async () => {
    await expect(
      withTenant(neverConnect, { orgId: "x' ; DROP TABLE org; --", userId: null }, async () => 1),
    ).rejects.toBeInstanceOf(TenantContextError);
  });

  it('refuses a non-UUID user id', async () => {
    await expect(
      withTenant(
        neverConnect,
        { orgId: '0d2a2b1e-1b7e-4b2a-9d31-5f0c1d8e9a11', userId: 'nope' },
        async () => 1,
      ),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});
