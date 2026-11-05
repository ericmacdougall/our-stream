// SPDX-License-Identifier: AGPL-3.0-only
// withTenant epoch pre-read and post-read against a real database (M2a snapshot semantics): a
// revocation committed between the pre-read and the first snapshot statement, and an epoch change after
// the snapshot. `authz_epoch` is an ordinary MVCC column; only the content epoch is a sequence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import { readEpochs, withTenant, type EpochCheck } from './tenant.js';
import { makeHarness, type Harness, type TestOrg } from './test-support.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const appUrl = process.env['DATABASE_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL'];

describe.skipIf(!adminUrl || !appUrl || !platformUrl)('withTenant epochs (integration)', () => {
  let h: Harness;
  let org: TestOrg;
  beforeAll(async () => {
    await runMigrations(adminUrl!);
    h = await makeHarness(adminUrl!, appUrl!, platformUrl!);
    org = await h.seedOrg();
  });
  afterAll(async () => {
    await h.close();
  });

  const statusInside = async (c: {
    query: (s: string, p: unknown[]) => Promise<{ rows: Array<{ status: string }> }>;
  }) =>
    (
      await c.query('SELECT status::text FROM org_membership WHERE org_id = $1 AND user_id = $2', [
        org.orgId,
        org.member,
      ])
    ).rows[0]!.status;
  const deactivate = () =>
    h.admin.query(
      `UPDATE org_membership SET status = 'deactivated' WHERE org_id = $1 AND user_id = $2`,
      [org.orgId, org.member],
    );
  const activate = () =>
    h.admin.query(
      `UPDATE org_membership SET status = 'active' WHERE org_id = $1 AND user_id = $2`,
      [org.orgId, org.member],
    );

  it('a quiet request has stable epochs, positive on the content side once content changed', async () => {
    const clip = await h.createClip(org);
    await h.publish(org, clip);
    let check: EpochCheck | undefined;
    await withTenant(
      h.app,
      { orgId: org.orgId, userId: org.member },
      async (c, before) => {
        expect(before).toBeDefined();
        expect(before!.orgContentEpoch).toBeGreaterThan(0);
        expect(before!.active).toBe(true);
        expect(await statusInside(c)).toBe('active');
      },
      { isolation: 'REPEATABLE READ', onEpochCheck: (x) => (check = x) },
    );
    expect(check!.stable).toBe(true);
    expect(check!.after).toEqual(check!.before);
  });

  it('a revocation committed between the pre-read and the first snapshot statement is seen by the snapshot and flagged (the pair is unstable, never cacheable)', async () => {
    let check: EpochCheck | undefined;
    let inside = '';
    await withTenant(
      h.app,
      { orgId: org.orgId, userId: org.member },
      async (c, before) => {
        inside = await statusInside(c);
        expect(before!.active).toBe(true); // the pre-read predates the revocation
      },
      {
        isolation: 'REPEATABLE READ',
        onEpochCheck: (x) => (check = x),
        testHooks: {
          onPhase: async (p) => {
            if (p === 'pre-read-done') await deactivate();
          },
        },
      },
    );
    try {
      expect(inside, 'a snapshot started after the commit must see the revocation').toBe(
        'deactivated',
      );
      expect(check!.stable).toBe(false);
      expect(check!.before.active).toBe(true);
      expect(check!.after!.active).toBe(false);
      expect(check!.after!.authzEpoch).toBeGreaterThan(check!.before.authzEpoch);
    } finally {
      await activate();
    }
  });

  it('a revocation committed after the snapshot started may be missed by that request once, and the post-read exposes it (control: reading inside the snapshot hides it)', async () => {
    let check: EpochCheck | undefined;
    let inside = '';
    let insideEpochs: Awaited<ReturnType<typeof readEpochs>> | undefined;
    await withTenant(
      h.app,
      { orgId: org.orgId, userId: org.member },
      async (c, before) => {
        inside = await statusInside(c); // first read after the snapshot started
        await deactivate(); // another transaction commits the revocation now
        inside += `|${await statusInside(c)}`; // the snapshot still shows the old state (pre-T may return pre-T content)
        insideEpochs = await readEpochs(c); // the broken variant: epochs read inside the snapshot
        expect(before!.authzEpoch).toBeGreaterThan(0);
      },
      { isolation: 'REPEATABLE READ', onEpochCheck: (x) => (check = x) },
    );
    try {
      expect(inside).toBe('active|active');
      // The MVCC authz_epoch read inside the snapshot equals the old value: a mismatch would stay hidden.
      expect(insideEpochs!.authzEpoch).toBe(check!.before.authzEpoch);
      expect(insideEpochs!.active).toBe(true);
      // The post-read, in its own short transaction after COMMIT, sees the change.
      expect(check!.stable).toBe(false);
      expect(check!.after!.active).toBe(false);
      expect(check!.after!.authzEpoch).toBeGreaterThan(check!.before.authzEpoch);
    } finally {
      await activate();
    }
  });

  it('the content epoch is a sequence: a change committed after the snapshot started shows in the post-read and, non-MVCC, even inside the snapshot', async () => {
    let check: EpochCheck | undefined;
    let insideContentEpoch = 0;
    await withTenant(
      h.app,
      { orgId: org.orgId, userId: org.member },
      async (c, before) => {
        await statusInside(c); // snapshot started
        const clip = await h.createClip(org);
        await h.publish(org, clip); // advances the org content epoch in another transaction
        insideContentEpoch = (await readEpochs(c)).orgContentEpoch;
        expect(insideContentEpoch).toBeGreaterThan(before!.orgContentEpoch);
      },
      { isolation: 'REPEATABLE READ', onEpochCheck: (x) => (check = x) },
    );
    expect(check!.stable).toBe(false);
    expect(check!.after!.orgContentEpoch).toBeGreaterThan(check!.before.orgContentEpoch);
  });

  it('a user-less context reads the content epoch only', async () => {
    let check: EpochCheck | undefined;
    await withTenant(h.app, { orgId: org.orgId, userId: null }, async () => undefined, {
      isolation: 'REPEATABLE READ',
      onEpochCheck: (x) => (check = x),
    });
    expect(check!.before).toMatchObject({ authzEpoch: 0, active: false });
    expect(check!.stable).toBe(true);
  });
});
