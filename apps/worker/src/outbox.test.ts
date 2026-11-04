// SPDX-License-Identifier: AGPL-3.0-only
// Fan-out rules against a scripted platform pool: which definer functions are called with which
// arguments, which jobs are enqueued, and that a failing event never blocks the batch.
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  dispatchEvent,
  drainOnce,
  retentionFor,
  type DomainEvent,
  MAX_EVENT_ATTEMPTS,
} from './outbox.js';
import { contentTransition } from './transition.js';
import type { JobContext } from './jobs.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONTENT = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const U1 = '44444444-4444-4444-8444-444444444444';
const U2 = '55555555-5555-4555-8555-555555555555';

type Row = Record<string, unknown>;
interface Script {
  schedule?: Row | null;
  audience?: Row[];
  viewers?: Row[];
  notifySetting?: boolean;
  events?: DomainEvent[];
  failNotifyFor?: string;
  /** value returned by the attempts UPDATE after a failure (default 1) */
  attemptsAfter?: number;
}

/** Minimal pg stand-in that answers the worker's SQL by function name and records every call. */
function fakeDb(script: Script) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const rows = ((): Row[] => {
      if (sql.includes('platform_content_schedule'))
        return script.schedule ? [script.schedule] : [];
      if (sql.includes('platform_audience_of_content')) return script.audience ?? [];
      if (sql.includes('platform_viewers_of_version')) return script.viewers ?? [];
      if (sql.includes('platform_org_notify_settings'))
        return [{ include_title_after_access_loss: script.notifySetting ?? false }];
      if (sql.includes('platform_notify')) {
        if (script.failNotifyFor && params[1] === script.failNotifyFor) throw new Error('db down');
        return [{ inserted: true }];
      }
      if (sql.includes('SET attempts = attempts + 1'))
        return [{ attempts: script.attemptsAfter ?? 1 }];
      if (sql.includes('FROM platform.domain_event'))
        return (script.events ?? []) as unknown as Row[];
      if (sql.includes('platform_content_transition')) return [];
      return [];
    })();
    return { rows, rowCount: rows.length } as unknown as pg.QueryResult;
  };
  const client = { query, release: () => undefined };
  const pool = { query, connect: async () => client } as unknown as pg.Pool;
  return { pool, calls, client };
}

function ctxWith(
  pool: pg.Pool,
  now = new Date('2026-11-03T12:00:00Z'),
): JobContext & { sent: Row[]; errors: unknown[][] } {
  const sent: Row[] = [];
  const errors: unknown[][] = [];
  return {
    tenantPool: pool,
    platformPool: pool,
    queue: {
      send: async (name, data, options) => {
        sent.push({ name, data, options });
        return 'job-id';
      },
    },
    store: {} as JobContext['store'],
    asr: {} as JobContext['asr'],
    limits: {} as JobContext['limits'],
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    },
    now: () => now,
    sent,
    errors,
  };
}

const ev = (type: string, extra: Partial<DomainEvent> = {}): DomainEvent => ({
  id: '1',
  org_id: ORG,
  type,
  subject_type: 'content',
  subject_id: CONTENT,
  version_id: VERSION,
  payload: {},
  ...extra,
});

describe('dispatchEvent', () => {
  it('content.version_uploaded enqueues media.process keyed by version', async () => {
    const db = fakeDb({});
    const ctx = ctxWith(db.pool);
    await dispatchEvent(db.pool, ctx, ev('content.version_uploaded'));
    expect(ctx.sent).toEqual([
      {
        name: 'media.process',
        data: { orgId: ORG, contentId: CONTENT, versionId: VERSION },
        options: { singletonKey: `media:${VERSION}` },
      },
    ]);
    expect(
      await dispatchEvent(db.pool, ctx, ev('content.version_uploaded', { version_id: null })),
    ).toMatch(/skipped/);
  });

  it('content.scheduled reads the schedule from the database and defers both transitions', async () => {
    const publishAt = new Date('2026-11-04T09:00:00Z');
    const expiresAt = new Date('2026-12-01T09:00:00Z');
    const db = fakeDb({
      schedule: {
        state: 'published',
        publish_at: publishAt,
        expires_at: expiresAt,
        retracted_at: null,
        current_version_id: VERSION,
      },
    });
    const ctx = ctxWith(db.pool);
    await dispatchEvent(
      db.pool,
      ctx,
      ev('content.scheduled', { payload: { publishAt: '1999-01-01T00:00:00Z' } }),
    );
    expect(ctx.sent).toEqual([
      {
        name: 'content.transition',
        data: { orgId: ORG, contentId: CONTENT, kind: 'publish', at: publishAt.toISOString() },
        options: {
          singletonKey: `publish:${CONTENT}:${publishAt.toISOString()}`,
          startAfter: publishAt,
          retentionSeconds: 21 * 3600 + 14 * 86_400, // outlives the 21 h deferral plus the default 14 d
        },
      },
      {
        name: 'content.transition',
        data: { orgId: ORG, contentId: CONTENT, kind: 'expire', at: expiresAt.toISOString() },
        options: {
          singletonKey: `expire:${CONTENT}:${expiresAt.toISOString()}`,
          startAfter: expiresAt,
          retentionSeconds: (28 * 24 - 3) * 3600 + 14 * 86_400,
        },
      },
    ]);
    expect(retentionFor(new Date('2000-01-01T00:00:00Z'), new Date())).toBe(14 * 86_400);
    // Payload times are never used.
    expect(JSON.stringify(ctx.sent)).not.toContain('1999');
  });

  it('content.scheduled for a draft or retracted item schedules nothing', async () => {
    for (const schedule of [
      { state: 'draft', publish_at: null, expires_at: null, retracted_at: null },
      { state: 'retracted', publish_at: new Date(), expires_at: null, retracted_at: new Date() },
      null,
    ]) {
      const db = fakeDb({ schedule });
      const ctx = ctxWith(db.pool);
      await dispatchEvent(db.pool, ctx, ev('content.expiry_scheduled'));
      expect(ctx.sent).toEqual([]);
    }
  });

  it('content.published notifies the audience with reason audience and dedupe published:{version}', async () => {
    const db = fakeDb({ audience: [{ user_id: U1 }, { user_id: U2 }] });
    const ctx = ctxWith(db.pool);
    expect(await dispatchEvent(db.pool, ctx, ev('content.published'))).toBe(
      'published fan-out: 2/2',
    );
    const notifies = db.calls.filter((c) => c.sql.includes('platform_notify'));
    expect(notifies.map((c) => c.params)).toEqual([
      [
        ORG,
        U1,
        'content.published',
        'audience',
        CONTENT,
        VERSION,
        null,
        `published:${VERSION}`,
        '{}',
      ],
      [
        ORG,
        U2,
        'content.published',
        'audience',
        CONTENT,
        VERSION,
        null,
        `published:${VERSION}`,
        '{}',
      ],
    ]);
  });

  it('content.retracted notifies viewers of that version only, without a title by default', async () => {
    const db = fakeDb({
      viewers: [{ user_id: U1, title_snapshot: 'Q3 all-hands' }],
      audience: [{ user_id: U2 }],
    });
    const ctx = ctxWith(db.pool);
    expect(await dispatchEvent(db.pool, ctx, ev('content.retracted'))).toBe(
      'retracted fan-out: 1/1',
    );
    const notifies = db.calls.filter((c) => c.sql.includes('platform_notify'));
    expect(notifies.map((c) => c.params)).toEqual([
      [
        ORG,
        U1,
        'content.retracted',
        'saw_version',
        CONTENT,
        VERSION,
        null,
        `retracted:${VERSION}`,
        '{}',
      ],
    ]);
    const viewersCall = db.calls.find((c) => c.sql.includes('platform_viewers_of_version'));
    expect(viewersCall?.params).toEqual([ORG, VERSION]);
  });

  it('content.retracted includes the view-time title snapshot only when the org opted in', async () => {
    const db = fakeDb({
      viewers: [{ user_id: U1, title_snapshot: 'Q3 all-hands' }],
      notifySetting: true,
    });
    const ctx = ctxWith(db.pool);
    await dispatchEvent(db.pool, ctx, ev('content.retracted'));
    const n = db.calls.find((c) => c.sql.includes('platform_notify'));
    expect(n?.params[6]).toBe('Q3 all-hands');
  });

  it('content.retracted without version_id falls back to the current version from the schedule', async () => {
    const db = fakeDb({
      viewers: [{ user_id: U1, title_snapshot: null }],
      schedule: {
        state: 'retracted',
        publish_at: null,
        expires_at: null,
        retracted_at: new Date(),
        current_version_id: VERSION,
      },
    });
    const ctx = ctxWith(db.pool);
    await dispatchEvent(db.pool, ctx, ev('content.retracted', { version_id: null }));
    expect(db.calls.find((c) => c.sql.includes('platform_viewers_of_version'))?.params).toEqual([
      ORG,
      VERSION,
    ]);
  });

  it('unknown event types are acknowledged without side effects', async () => {
    const db = fakeDb({});
    const ctx = ctxWith(db.pool);
    expect(await dispatchEvent(db.pool, ctx, ev('comment.created'))).toMatch(/ignored/);
    expect(ctx.sent).toEqual([]);
    expect(db.calls).toEqual([]);
  });
});

describe('drainOnce', () => {
  it('marks successful events processed, isolates a failing event in its savepoint and continues', async () => {
    const db = fakeDb({
      events: [
        ev('content.version_uploaded', { id: '10' }),
        ev('content.published', { id: '11' }),
        ev('content.version_uploaded', { id: '12' }),
      ],
      audience: [{ user_id: U1 }],
      failNotifyFor: U1,
    });
    const ctx = ctxWith(db.pool);
    const r = await drainOnce(ctx);
    expect(r).toEqual({ processed: 2, failed: 1, parked: 0 });
    // Delivery order is the outbox id order, not reordered by attempt count (verification N4).
    expect(db.calls[1]!.sql).toMatch(/ORDER BY id LIMIT/);
    const marked = db.calls
      .filter((c) => c.sql.includes('SET processed_at'))
      .map((c) => c.params[0]);
    expect(marked).toEqual(['10', '12']);
    const sql = db.calls.map((c) => c.sql);
    expect(sql).toContain('ROLLBACK TO SAVEPOINT ev');
    expect(sql[sql.length - 1]).toBe('COMMIT');
    expect(sql[0]).toBe('BEGIN');
  });

  it('reports a parked event distinctly once it reaches MAX_EVENT_ATTEMPTS (N4)', async () => {
    const db = fakeDb({
      events: [ev('content.published', { id: '20' })],
      audience: [{ user_id: U1 }],
      failNotifyFor: U1,
      attemptsAfter: MAX_EVENT_ATTEMPTS,
    });
    const ctx = ctxWith(db.pool);
    const r = await drainOnce(ctx);
    expect(r).toEqual({ processed: 0, failed: 1, parked: 1 });
    const parkedLog = ctx.errors.find((a) => String(a[1]).includes('parked'));
    expect(parkedLog?.[0]).toMatchObject({ eventId: '20', attempts: MAX_EVENT_ATTEMPTS });
  });
});

describe('contentTransition', () => {
  const base = { orgId: ORG, contentId: CONTENT, kind: 'publish', at: '2026-11-03T11:00:00Z' };
  const due = {
    state: 'published',
    publish_at: new Date('2026-11-03T11:00:00Z'),
    expires_at: null,
    retracted_at: null,
  };

  it('applies a due publish transition', async () => {
    const db = fakeDb({ schedule: due });
    await contentTransition(base, ctxWith(db.pool));
    const t = db.calls.find((c) => c.sql.includes('platform_content_transition'));
    expect(t?.params).toEqual([ORG, CONTENT, 'publish']);
  });

  it('is a no-op when rescheduled, not due, retracted, or missing', async () => {
    const cases = [
      { ...due, publish_at: new Date('2026-11-05T11:00:00Z') }, // rescheduled later
      { ...due, publish_at: new Date('2026-11-03T13:00:00Z') }, // not yet due (now = 12:00)
      { ...due, retracted_at: new Date(), state: 'retracted' },
      { ...due, publish_at: null },
      null,
    ];
    for (const schedule of cases) {
      const db = fakeDb({ schedule });
      await contentTransition(base, ctxWith(db.pool));
      expect(db.calls.some((c) => c.sql.includes('platform_content_transition'))).toBe(false);
    }
  });

  it('expire uses expires_at and rejects malformed jobs before touching the database', async () => {
    const db = fakeDb({ schedule: { ...due, expires_at: new Date('2026-11-03T11:00:00Z') } });
    await contentTransition({ ...base, kind: 'expire' }, ctxWith(db.pool));
    expect(db.calls.find((c) => c.sql.includes('platform_content_transition'))?.params).toEqual([
      ORG,
      CONTENT,
      'expire',
    ]);
    await expect(
      contentTransition({ ...base, kind: 'delete' }, ctxWith(db.pool)),
    ).rejects.toThrow();
    await expect(contentTransition({ orgId: 'nope' }, ctxWith(db.pool))).rejects.toThrow();
  });
});
