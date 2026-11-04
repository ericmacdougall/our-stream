// SPDX-License-Identifier: Apache-2.0
// Engagement milestones (ADR-0006, contract EngagementEventRequest). One client session key per
// (content, version) playback session, persisted with the milestones already sent so a restart
// never resends them; a completed session (or one older than the server's 24 h window) is closed and
// the next play starts a new session, which the server counts as a rewatch.
//
// Sending is a three-step claim so two player events crossing a milestone together send one
// request: `take` claims synchronously in memory, `commit` persists after the server answered
// (`recorded:false` still counts as sent), `release` drops the claim when the send failed.
import type { KeyValueStore } from './kv';

export type Milestone = 'view_start' | 'progress_25' | 'progress_50' | 'progress_75' | 'complete';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Records older than this, or beyond MAX_SESSIONS, are pruned from the store. */
export const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS = 200;
const INDEX_KEY = 'eng:index';

export interface PlaybackIds {
  /** The signed-in user: bookkeeping is per user so a shared device never inherits another user's session. */
  userId: string;
  contentId: string;
  versionId: string;
}
export interface PlaybackSession {
  sessionKey: string;
  sent: Milestone[];
  completed: boolean;
}
interface StoredSession extends PlaybackSession {
  updatedAt: number;
}

const PROGRESS: ReadonlyArray<[Milestone, number]> = [
  ['progress_25', 25],
  ['progress_50', 50],
  ['progress_75', 75],
];

/** Progress milestones reached at `positionMs` that have not been sent yet, in order. */
export function dueMilestones(
  positionMs: number,
  durationMs: number | null | undefined,
  sent: ReadonlyArray<Milestone>,
): Milestone[] {
  if (!durationMs || durationMs <= 0) return [];
  const pct = (positionMs / durationMs) * 100;
  return PROGRESS.filter(([m, at]) => pct >= at && !sent.includes(m)).map(([m]) => m);
}

export interface TrackerDeps {
  store: KeyValueStore;
  newKey: () => string;
  now?: () => number;
}

export interface Tracker {
  /** Loads or opens the playback session for a clip; must run before `take`. */
  start(ids: PlaybackIds): Promise<PlaybackSession>;
  /** Claims a milestone: true when it is new for this session and not already in flight. */
  take(ids: PlaybackIds, type: Milestone): boolean;
  /** Marks a claimed milestone as sent (after the server answered). Never throws. */
  commit(ids: PlaybackIds, type: Milestone): Promise<void>;
  /** Drops a claim after a failed send so it can be retried. */
  release(ids: PlaybackIds, type: Milestone): void;
}

const keyFor = (ids: PlaybackIds) => `eng:${ids.userId}:${ids.contentId}:${ids.versionId}`;

export function createTracker(deps: TrackerDeps): Tracker {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, StoredSession>();
  const inflight = new Set<string>();
  // Writes (record + index) run one at a time so two commits cannot interleave the index rewrite.
  let queue: Promise<void> = Promise.resolve();

  async function load(ids: PlaybackIds): Promise<StoredSession | null> {
    const key = keyFor(ids);
    const cached = cache.get(key);
    if (cached) return cached;
    try {
      const raw = await deps.store.get(key);
      if (!raw) return null;
      const s = JSON.parse(raw) as Partial<StoredSession>;
      if (
        typeof s.sessionKey !== 'string' ||
        !Array.isArray(s.sent) ||
        typeof s.updatedAt !== 'number'
      )
        return null;
      const session: StoredSession = {
        sessionKey: s.sessionKey,
        sent: s.sent.filter((m): m is Milestone => typeof m === 'string'),
        completed: s.completed === true,
        updatedAt: s.updatedAt,
      };
      cache.set(key, session);
      return session;
    } catch {
      return null;
    }
  }

  function save(ids: PlaybackIds, session: StoredSession): Promise<void> {
    const key = keyFor(ids);
    cache.set(key, session);
    queue = queue.then(async () => {
      try {
        await deps.store.set(key, JSON.stringify(session));
        await prune(key, session.updatedAt);
      } catch {
        // Bookkeeping must never interrupt playback; the in-memory cache still dedupes this run.
      }
    });
    return queue;
  }

  async function prune(touched: string, at: number): Promise<void> {
    let index: [string, number][] = [];
    try {
      const raw = await deps.store.get(INDEX_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        index = parsed.filter(
          (e): e is [string, number] =>
            Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number',
        );
      }
    } catch {
      index = [];
    }
    index = index.filter(([k]) => k !== touched);
    index.push([touched, at]);
    index.sort((a, b) => a[1] - b[1]);
    const cutoff = now() - RECORD_TTL_MS;
    const drop: string[] = [];
    while (
      index.length > 0 &&
      (index.length > MAX_SESSIONS || (index[0] as [string, number])[1] < cutoff)
    ) {
      const [k] = index.shift() as [string, number];
      if (k !== touched) drop.push(k);
    }
    for (const k of drop) {
      cache.delete(k);
      await deps.store.remove(k);
    }
    await deps.store.set(INDEX_KEY, JSON.stringify(index));
  }

  function fresh(): StoredSession {
    return { sessionKey: deps.newKey(), sent: [], completed: false, updatedAt: now() };
  }

  return {
    async start(ids) {
      const existing = await load(ids);
      const stale = !existing || existing.completed || now() - existing.updatedAt > SESSION_TTL_MS;
      const session = stale ? fresh() : existing;
      if (stale) await save(ids, session);
      return {
        sessionKey: session.sessionKey,
        sent: [...session.sent],
        completed: session.completed,
      };
    },
    take(ids, type) {
      const key = keyFor(ids);
      const session = cache.get(key);
      if (!session) return false;
      const claim = `${key}:${type}`;
      if (session.sent.includes(type) || inflight.has(claim)) return false;
      inflight.add(claim);
      return true;
    },
    async commit(ids, type) {
      const key = keyFor(ids);
      inflight.delete(`${key}:${type}`);
      const session = cache.get(key);
      if (!session || session.sent.includes(type)) return;
      await save(ids, {
        ...session,
        sent: [...session.sent, type],
        completed: session.completed || type === 'complete',
        updatedAt: now(),
      });
    },
    release(ids, type) {
      inflight.delete(`${keyFor(ids)}:${type}`);
    },
  };
}
