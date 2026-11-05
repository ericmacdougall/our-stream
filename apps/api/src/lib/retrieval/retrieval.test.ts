// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CACHE_MAX_IDS_PER_ENTRY, CACHE_MAX_IDS_TOTAL } from './constants.js';
import { EmbedRefusedError, embedWithTimeout, type QueryEmbedder } from './embedder.js';
import { fuse, snippetOf } from './engine.js';
import { incrementCounter, LEAK_CHECK_FAILED, readCounter } from './metrics.js';
import {
  bucketOf,
  cacheKey,
  packIds,
  PermittedIdCache,
  unpackIds,
  type CacheKeyParts,
} from './permitted-cache.js';
import { TrySemaphore } from './semaphore.js';
import { normalizeRetrievalQuery } from '../../routes/retrieval.js';

const parts = (over: Partial<CacheKeyParts> = {}): CacheKeyParts => ({
  orgId: randomUUID(),
  userId: randomUUID(),
  authzEpoch: 1,
  orgContentEpoch: 1,
  bucket: 100,
  ...over,
});
const ids = (n: number) => Array.from({ length: n }, () => randomUUID());

describe('permitted-id cache', () => {
  it('round-trips ids as 16-byte values and is exact', () => {
    const a = ids(50);
    const buf = packIds(a);
    expect(buf.length).toBe(50 * 16);
    expect(unpackIds(buf)).toEqual(a);
    const c = new PermittedIdCache();
    const p = parts();
    expect(c.get(p)).toBeNull();
    expect(c.put(p, a)).toBe(true);
    expect(c.get(p)).toEqual(a);
    expect(a.length).toBeGreaterThan(0);
  });

  it('keys on org, user, both epochs and the bucket (a change in any misses)', () => {
    const c = new PermittedIdCache();
    const p = parts();
    c.put(p, ids(3));
    for (const over of [
      { orgId: randomUUID() },
      { userId: randomUUID() },
      { authzEpoch: 2 },
      { orgContentEpoch: 2 },
    ])
      expect(c.get({ ...p, ...over }), JSON.stringify(Object.keys(over))).toBeNull();
    expect(c.get(p)).not.toBeNull();
    expect(cacheKey(p)).toContain(String(p.bucket));
  });

  it('never caches a set above the per-entry bound', () => {
    const c = new PermittedIdCache();
    expect(c.put(parts(), ids(CACHE_MAX_IDS_PER_ENTRY))).toBe(true);
    expect(c.put(parts(), ids(CACHE_MAX_IDS_PER_ENTRY + 1))).toBe(false);
    expect(c.size).toBe(1);
  });

  it('purges entries older than the current bucket on put and on get', () => {
    const c = new PermittedIdCache();
    const old = parts({ bucket: 10 });
    const fresh = parts({ bucket: 11 });
    c.put(old, ids(5));
    expect(c.size).toBe(1);
    expect(c.get(fresh)).toBeNull(); // a lookup in bucket 11 purges bucket 10
    expect(c.size).toBe(0);
    expect(c.totalIds).toBe(0);
    c.put(old, ids(5));
    c.put(fresh, ids(7)); // a put in bucket 11 purges bucket 10 as well
    expect(c.size).toBe(1);
    expect(c.get(old)).toBeNull();
    expect(c.totalIds).toBe(7);
  });

  it('is an LRU bounded to 200,000 ids in total, memory 16 bytes per id', () => {
    const c = new PermittedIdCache();
    const keep = parts();
    const keepIds = ids(10);
    c.put(keep, keepIds);
    const heapBefore = process.memoryUsage().heapUsed;
    // 60 entries x 5,000 ids = 300,000 ids offered; only 200,000 may stay.
    for (let i = 0; i < 60; i += 1) {
      if (i % 5 === 0) expect(c.get(keep)).not.toBeNull(); // keep `keep` recently used
      c.put(parts(), ids(CACHE_MAX_IDS_PER_ENTRY));
    }
    expect(c.totalIds).toBeLessThanOrEqual(CACHE_MAX_IDS_TOTAL);
    expect(c.totalIds).toBeGreaterThan(CACHE_MAX_IDS_TOTAL - CACHE_MAX_IDS_PER_ENTRY);
    expect(c.bytes).toBe(c.totalIds * 16);
    expect(c.bytes).toBeLessThanOrEqual(CACHE_MAX_IDS_TOTAL * 16);
    expect(c.get(keep)).toEqual(keepIds); // recently used survives eviction
    // the retained id bytes are held in Buffers outside the JS heap string pool: bound the growth loosely.
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(150 * 1024 * 1024);
  });

  it('rejects a non-UUID id instead of caching garbage', () => {
    expect(() => packIds(['not-a-uuid'])).toThrow();
  });

  it('buckets time by 30 s', () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(29_999)).toBe(0);
    expect(bucketOf(30_000)).toBe(1);
  });
});

describe('try-acquire semaphore', () => {
  it('never waits: the fifth acquire of four fails at once, release frees a slot, double release is harmless', () => {
    const s = new TrySemaphore(4);
    const rel = [s.tryAcquire(), s.tryAcquire(), s.tryAcquire(), s.tryAcquire()];
    expect(rel.every((r) => r !== null)).toBe(true);
    expect(s.tryAcquire()).toBeNull();
    rel[0]!();
    rel[0]!();
    expect(s.active).toBe(3);
    expect(s.tryAcquire()).not.toBeNull();
  });
});

describe('query embedding', () => {
  const embedder = (fn: (signal: AbortSignal) => Promise<number[]>): QueryEmbedder => ({
    model: 'm',
    embed: (_t, signal) => fn(signal),
  });
  it('returns the vector on success', async () => {
    const r = await embedWithTimeout(
      embedder(async () => [0.1, 0.2]),
      'x',
      100,
    );
    expect(r).toEqual({ ok: true, vector: [0.1, 0.2] });
  });
  it('degrades on timeout, error, refusal, no embedder, zero vector and NaN', async () => {
    const slow = embedder(
      (signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('x')))),
    );
    expect(await embedWithTimeout(slow, 'x', 20)).toEqual({ ok: false, reason: 'embed_timeout' });
    expect(
      await embedWithTimeout(
        embedder(async () => {
          throw new Error('boom');
        }),
        'x',
      ),
    ).toEqual({ ok: false, reason: 'embed_unavailable' });
    expect(
      await embedWithTimeout(
        embedder(async () => {
          throw new EmbedRefusedError();
        }),
        'x',
      ),
    ).toEqual({ ok: false, reason: 'embed_refused' });
    expect(await embedWithTimeout(null, 'x')).toEqual({ ok: false, reason: 'embed_unavailable' });
    expect(
      await embedWithTimeout(
        embedder(async () => [0, 0, 0]),
        'x',
      ),
    ).toEqual({
      ok: false,
      reason: 'embed_unavailable',
    });
    expect(
      await embedWithTimeout(
        embedder(async () => [Number.NaN, 1]),
        'x',
      ),
    ).toEqual({
      ok: false,
      reason: 'embed_unavailable',
    });
  });
});

describe('fusion and text helpers', () => {
  it('fuses by reciprocal rank, ties broken by chunk id, deterministic', () => {
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';
    const c = '00000000-0000-4000-8000-000000000003';
    expect(
      fuse(
        [
          [a, b],
          [b, c],
        ],
        3,
      ).map((x) => x.id),
    ).toEqual([b, a, c]);
    expect(fuse([[c], [a]], 2).map((x) => x.id)).toEqual([a, c]); // equal scores: id order
    expect(fuse([[a, b, c]], 2).map((x) => x.id)).toEqual([a, b]);
  });
  it('normalises queries: NFC, zero-width removed, controls to spaces', () => {
    expect(normalizeRetrievalQuery('café')).toBe('café');
    expect(normalizeRetrievalQuery('ab​cd﻿')).toBe('abcd');
    expect(normalizeRetrievalQuery('a\u0000b\tc')).toBe('a b c');
    expect(normalizeRetrievalQuery('  ​ ')).toBe('');
  });
  it('snippets are bounded by code points and carry no control characters', () => {
    const s = snippetOf('x\u0000y' + '\u{1F600}'.repeat(400));
    expect(Array.from(s).length).toBe(300);
    expect(s).not.toContain('\u0000');
  });
  it('counts leak-check failures', () => {
    const before = readCounter(LEAK_CHECK_FAILED);
    incrementCounter(LEAK_CHECK_FAILED);
    expect(readCounter(LEAK_CHECK_FAILED)).toBe(before + 1);
  });
});
