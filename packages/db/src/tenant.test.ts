// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { TenantContextError, withTenant, type EpochCheck } from './tenant.js';

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

describe('withTenant epoch pre-read and post-read (unit, scripted client)', () => {
  const ORG = '0d2a2b1e-1b7e-4b2a-9d31-5f0c1d8e9a11';
  const USER = '1d2a2b1e-1b7e-4b2a-9d31-5f0c1d8e9a22';

  function scripted(
    opts: { failPostRead?: boolean; epochs?: Array<{ content: string; authz: string }> } = {},
  ) {
    const log: string[] = [];
    const epochs = opts.epochs ?? [
      { content: '5', authz: '7' },
      { content: '5', authz: '7' },
    ];
    let readIdx = -1;
    let reads = 0;
    const client = {
      release: () => undefined,
      query: async (sql: string) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        log.push(
          s.startsWith('SELECT set_config')
            ? 'set_config'
            : s.startsWith('SELECT current_org_content_epoch')
              ? 'read content epoch'
              : s.startsWith('SELECT authz_epoch')
                ? 'read membership epoch'
                : s,
        );
        if (s.startsWith('SELECT current_org_content_epoch')) {
          reads += 1;
          if (opts.failPostRead && reads > 1) throw new Error('post-read failed');
          readIdx += 1;
          return { rows: [{ e: epochs[Math.min(readIdx, epochs.length - 1)]!.content }] };
        }
        if (s.startsWith('SELECT authz_epoch')) {
          return {
            rows: [
              {
                authz_epoch: epochs[Math.min(readIdx, epochs.length - 1)]!.authz,
                status: 'active',
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    return { pool, log };
  }

  it('reads the epochs in a short READ COMMITTED transaction before the snapshot and another after COMMIT, in this order', async () => {
    const { pool, log } = scripted();
    let check: EpochCheck | undefined;
    const result = await withTenant(
      pool,
      { orgId: ORG, userId: USER },
      async (_c, before) => {
        log.push('fn');
        expect(before).toEqual({ authzEpoch: 7, orgContentEpoch: 5, active: true });
        return 'done';
      },
      { isolation: 'REPEATABLE READ', onEpochCheck: (c) => (check = c) },
    );
    expect(result).toBe('done');
    expect(log).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'set_config',
      'read content epoch',
      'read membership epoch',
      'COMMIT',
      'BEGIN ISOLATION LEVEL REPEATABLE READ',
      'set_config',
      'fn',
      'COMMIT',
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'set_config',
      'read content epoch',
      'read membership epoch',
      'COMMIT',
    ]);
    expect(check).toEqual({
      before: { authzEpoch: 7, orgContentEpoch: 5, active: true },
      after: { authzEpoch: 7, orgContentEpoch: 5, active: true },
      stable: true,
    });
  });

  it('an epoch that moved between the reads is reported unstable (the result is still returned)', async () => {
    for (const moved of [
      [
        { content: '5', authz: '7' },
        { content: '6', authz: '7' },
      ],
      [
        { content: '5', authz: '7' },
        { content: '5', authz: '8' },
      ],
    ]) {
      const { pool } = scripted({ epochs: moved });
      let check: EpochCheck | undefined;
      const r = await withTenant(pool, { orgId: ORG, userId: USER }, async () => 42, {
        isolation: 'REPEATABLE READ',
        onEpochCheck: (c) => (check = c),
      });
      expect(r).toBe(42);
      expect(check?.stable).toBe(false);
    }
  });

  it('a failing post-read never fails the request: after is null and the pair is unstable', async () => {
    const { pool } = scripted({ failPostRead: true });
    let check: EpochCheck | undefined;
    const r = await withTenant(pool, { orgId: ORG, userId: USER }, async () => 'ok', {
      isolation: 'REPEATABLE READ',
      onEpochCheck: (c) => (check = c),
    });
    expect(r).toBe('ok');
    expect(check).toMatchObject({ after: null, stable: false });
  });

  it('without the option nothing extra is read (existing behaviour)', async () => {
    const { pool, log } = scripted();
    await withTenant(pool, { orgId: ORG, userId: USER }, async () => 1);
    expect(log).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', 'set_config', 'COMMIT']);
  });
});
