// SPDX-License-Identifier: AGPL-3.0-only
// Permitted-id cache (ADR-0002, ADR-0004, M2a spec "Cache contract"). It stores ONLY content ids (16 bytes
// each), never chunk text. A cached set can only NARROW the candidates of a request: every returned chunk is
// re-checked by the full predicate inside the request's snapshot, so a stale entry can never add a result.
// Newly permitted content (a publish, an audience grow, publish_at crossing) may be absent for at most one
// time bucket unless an epoch bump changes the key. Per-process LRU bounded in total ids and per entry.
import { CACHE_BUCKET_MS, CACHE_MAX_IDS_PER_ENTRY, CACHE_MAX_IDS_TOTAL } from './constants.js';

export interface CacheKeyParts {
  orgId: string;
  userId: string;
  authzEpoch: number;
  orgContentEpoch: number;
  bucket: number;
}

export const bucketOf = (nowMs: number, bucketMs = CACHE_BUCKET_MS): number =>
  Math.floor(nowMs / bucketMs);

export const cacheKey = (p: CacheKeyParts): string =>
  `${p.orgId}|${p.userId}|${p.authzEpoch}|${p.orgContentEpoch}|${p.bucket}`;

const HEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function packIds(ids: readonly string[]): Buffer {
  const out = Buffer.allocUnsafe(ids.length * 16);
  ids.forEach((id, i) => {
    const lower = id.toLowerCase();
    if (!HEX_UUID.test(lower)) throw new Error('permitted cache: id is not a UUID');
    out.write(lower.replace(/-/g, ''), i * 16, 16, 'hex');
  });
  return out;
}

export function unpackIds(buf: Buffer): string[] {
  const ids: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const h = buf.toString('hex', i, i + 16);
    ids.push(
      `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    );
  }
  return ids;
}

interface Entry {
  ids: Buffer;
  count: number;
  bucket: number;
}

export interface CacheLimits {
  maxTotalIds: number;
  maxIdsPerEntry: number;
}

export class PermittedIdCache {
  private readonly entries = new Map<string, Entry>(); // insertion order = recency order
  private total = 0;
  /** Lookup counters (tests and ops). */
  hits = 0;
  misses = 0;
  constructor(
    private readonly limits: CacheLimits = {
      maxTotalIds: CACHE_MAX_IDS_TOTAL,
      maxIdsPerEntry: CACHE_MAX_IDS_PER_ENTRY,
    },
  ) {}

  /** Returns the cached ids or null. Entries from an older bucket are purged first. */
  get(parts: CacheKeyParts): string[] | null {
    this.purgeBefore(parts.bucket);
    const key = cacheKey(parts);
    const e = this.entries.get(key);
    if (!e) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    this.entries.delete(key); // refresh recency
    this.entries.set(key, e);
    return unpackIds(e.ids);
  }

  /** Stores the set unless it exceeds the per-entry bound (such a set is never cached, ADR-0002). */
  put(parts: CacheKeyParts, ids: readonly string[]): boolean {
    this.purgeBefore(parts.bucket);
    if (ids.length > this.limits.maxIdsPerEntry) return false;
    const key = cacheKey(parts);
    this.drop(key);
    this.entries.set(key, { ids: packIds(ids), count: ids.length, bucket: parts.bucket });
    this.total += ids.length;
    while (this.total > this.limits.maxTotalIds) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
    return true;
  }

  /** Removes entries whose bucket is older than `bucket`. */
  purgeBefore(bucket: number): void {
    for (const [key, e] of this.entries) if (e.bucket < bucket) this.drop(key);
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.total -= e.count;
  }

  get totalIds(): number {
    return this.total;
  }
  get size(): number {
    return this.entries.size;
  }
  get bytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.ids.length;
    return n;
  }
  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}
