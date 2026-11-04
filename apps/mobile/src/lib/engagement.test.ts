// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  classifyEngagementFailure,
  createTracker,
  dueMilestones,
  MAX_SESSIONS,
  SESSION_TTL_MS,
} from './engagement';
import { memoryStore, type KeyValueStore } from './kv';

describe('dueMilestones', () => {
  it('reports each milestone once, catching up out of order', () => {
    expect(dueMilestones(26_000, 100_000, [])).toEqual(['progress_25']);
    expect(dueMilestones(80_000, 100_000, ['progress_25'])).toEqual(['progress_50', 'progress_75']);
    expect(dueMilestones(80_000, 100_000, ['progress_25', 'progress_50', 'progress_75'])).toEqual(
      [],
    );
    expect(dueMilestones(10_000, 100_000, [])).toEqual([]);
  });
  it('is silent without a duration', () => {
    expect(dueMilestones(50_000, null, [])).toEqual([]);
    expect(dueMilestones(50_000, 0, [])).toEqual([]);
  });
});

describe('createTracker', () => {
  const ids = { userId: 'u1', contentId: 'c1', versionId: 'v1' };

  it('keeps one session key per content across restarts and sends each milestone once', async () => {
    const store = memoryStore();
    let now = 1_000;
    const t1 = createTracker({ store, newKey: () => 'key-1', now: () => now });
    expect(await t1.start(ids)).toEqual({ sessionKey: 'key-1', sent: [], completed: false });
    expect(t1.take(ids, 'view_start')).toBe(true);
    expect(t1.take(ids, 'view_start')).toBe(false); // in flight
    await t1.commit(ids, 'view_start');
    expect(t1.take(ids, 'view_start')).toBe(false); // sent
    expect(t1.take(ids, 'progress_25')).toBe(true);
    await t1.commit(ids, 'progress_25');

    // App restart: a new tracker over the same store, a new key generator.
    now += 60_000;
    const t2 = createTracker({ store, newKey: () => 'key-2', now: () => now });
    const resumed = await t2.start(ids);
    expect(resumed.sessionKey).toBe('key-1');
    expect(resumed.sent).toEqual(['view_start', 'progress_25']);
    expect(t2.take(ids, 'view_start')).toBe(false);
    expect(t2.take(ids, 'progress_25')).toBe(false);
    expect(t2.take(ids, 'progress_50')).toBe(true);
  });

  it('lets two concurrent events claim a milestone once, and a failed send retry', async () => {
    const t = createTracker({ store: memoryStore(), newKey: () => 'k', now: () => 1 });
    await t.start(ids);
    expect([t.take(ids, 'progress_25'), t.take(ids, 'progress_25')]).toEqual([true, false]);
    t.release(ids, 'progress_25');
    expect(t.take(ids, 'progress_25')).toBe(true);
    await t.commit(ids, 'progress_25');
    t.release(ids, 'progress_25');
    expect(t.take(ids, 'progress_25')).toBe(false);
  });

  it('refuses claims before start and persists nothing for them', async () => {
    const store = memoryStore();
    const t = createTracker({ store, newKey: () => 'k', now: () => 1 });
    expect(t.take(ids, 'view_start')).toBe(false);
    await t.commit(ids, 'view_start');
    expect(store.dump()).toEqual({});
  });

  it('starts a fresh session (rewatch) after completion and after the ttl', async () => {
    const store = memoryStore();
    let now = 1_000;
    let n = 0;
    const t = createTracker({ store, newKey: () => `key-${++n}`, now: () => now });
    await t.start(ids);
    t.take(ids, 'view_start');
    await t.commit(ids, 'view_start');
    t.take(ids, 'complete');
    await t.commit(ids, 'complete');
    const again = await t.start(ids);
    expect(again).toEqual({ sessionKey: 'key-2', sent: [], completed: false });
    expect(t.take(ids, 'view_start')).toBe(true);

    now += SESSION_TTL_MS + 1;
    const later = await t.start(ids);
    expect(later.sessionKey).toBe('key-3');
  });

  it('keeps separate state per version and survives a corrupted record', async () => {
    const store = memoryStore({ 'eng:u1:c1:v1': '{nope' });
    const t = createTracker({ store, newKey: () => 'k', now: () => 5 });
    expect((await t.start(ids)).sessionKey).toBe('k');
    t.take(ids, 'view_start');
    await t.commit(ids, 'view_start');
    const v2 = { userId: 'u1', contentId: 'c1', versionId: 'v2' };
    await t.start(v2);
    expect(t.take(v2, 'view_start')).toBe(true);
  });

  it('prunes the oldest records beyond the cap', async () => {
    const store = memoryStore();
    let now = 1;
    const t = createTracker({ store, newKey: () => 'k', now: () => now++ });
    for (let i = 0; i <= MAX_SESSIONS; i++)
      await t.start({ userId: 'u1', contentId: `c${i}`, versionId: 'v' });
    const keys = Object.keys(store.dump()).filter((k) => k.startsWith('eng:u1:c'));
    expect(keys).toHaveLength(MAX_SESSIONS);
    expect(keys).not.toContain('eng:u1:c0:v');
    expect(keys).toContain(`eng:u1:c${MAX_SESSIONS}:v`);
  });

  it('keeps users apart on a shared device', async () => {
    const store = memoryStore();
    const a = createTracker({ store, newKey: () => 'key-a', now: () => 1 });
    await a.start(ids);
    a.take(ids, 'view_start');
    await a.commit(ids, 'view_start');
    const b = createTracker({ store, newKey: () => 'key-b', now: () => 2 });
    const other = { ...ids, userId: 'u2' };
    expect((await b.start(other)).sessionKey).toBe('key-b');
    expect(b.take(other, 'view_start')).toBe(true);
    expect((await b.start(ids)).sent).toEqual(['view_start']);
  });

  it('serialises index writes from concurrent commits', async () => {
    const store = memoryStore();
    const t = createTracker({ store, newKey: () => 'k', now: () => 1 });
    const a = { userId: 'u', contentId: 'a', versionId: 'v' };
    const b = { userId: 'u', contentId: 'b', versionId: 'v' };
    await Promise.all([t.start(a), t.start(b)]);
    t.take(a, 'view_start');
    t.take(b, 'view_start');
    await Promise.all([t.commit(a, 'view_start'), t.commit(b, 'view_start')]);
    const index = JSON.parse(store.dump()['eng:index'] ?? '[]') as [string, number][];
    expect(index.map(([k]) => k).sort()).toEqual(['eng:u:a:v', 'eng:u:b:v']);
  });

  it('abandons a milestone for the session and backs off transient failures', async () => {
    const store = memoryStore();
    let now = 1_000;
    const t = createTracker({ store, newKey: () => 'k', now: () => now });
    await t.start(ids);
    expect(t.take(ids, 'progress_25')).toBe(true);
    t.abandon(ids, 'progress_25');
    expect(t.take(ids, 'progress_25')).toBe(false);
    expect(store.dump()['eng:u1:c1:v1']).not.toContain('progress_25'); // not persisted as sent
    expect(t.take(ids, 'progress_50')).toBe(true);
    t.release(ids, 'progress_50', { retryAfterMs: 15_000 });
    expect(t.take(ids, 'progress_50')).toBe(false);
    now += 14_999;
    expect(t.take(ids, 'progress_50')).toBe(false);
    now += 1;
    expect(t.take(ids, 'progress_50')).toBe(true);
    await t.commit(ids, 'progress_50');
    // A fresh session (after complete) forgets the give-up.
    t.take(ids, 'complete');
    await t.commit(ids, 'complete');
    await t.start(ids);
    expect(t.take(ids, 'progress_25')).toBe(true);
  });

  it('never throws when the store fails', async () => {
    const broken: KeyValueStore = {
      get: async () => null,
      set: async () => {
        throw new Error('disk full');
      },
      remove: async () => {},
    };
    const t = createTracker({ store: broken, newKey: () => 'k', now: () => 1 });
    await expect(t.start(ids)).resolves.toEqual({ sessionKey: 'k', sent: [], completed: false });
    expect(t.take(ids, 'view_start')).toBe(true);
    await expect(t.commit(ids, 'view_start')).resolves.toBeUndefined();
    expect(t.take(ids, 'view_start')).toBe(false);
  });
});

describe('classifyEngagementFailure', () => {
  it('maps server answers to the retry policy', () => {
    expect(classifyEngagementFailure('content_not_found', 404)).toBe('unavailable');
    expect(classifyEngagementFailure('retracted', 409)).toBe('unavailable');
    expect(classifyEngagementFailure('unknown', 404)).toBe('unavailable');
    expect(classifyEngagementFailure('stale_version', 409)).toBe('stale');
    expect(classifyEngagementFailure('rate_limited', 429)).toBe('backoff');
    expect(classifyEngagementFailure('internal', 500)).toBe('backoff');
    expect(classifyEngagementFailure('unknown', undefined)).toBe('backoff'); // network
    expect(classifyEngagementFailure('validation', 400)).toBe('abandon');
    expect(classifyEngagementFailure('role_forbidden', 403)).toBe('abandon');
    expect(classifyEngagementFailure('idempotency_mismatch', 409)).toBe('abandon');
  });
});
