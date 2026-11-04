// SPDX-License-Identifier: AGPL-3.0-only
// Outbox drain and fan-out rules (ADR-0005). Events are processed at least once; every side effect is
// idempotent: pg-boss singleton keys for jobs, dedupe keys for notifications. Schedule times are read
// from the database, never from the event payload.
import type pg from 'pg';
import type { Handler, JobContext } from './jobs.js';
import { QUEUES } from './jobs.js';

export interface DomainEvent {
  id: string;
  org_id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  version_id: string | null;
  payload: Record<string, unknown>;
}

interface Schedule {
  state: 'draft' | 'published' | 'retracted';
  publish_at: Date | null;
  expires_at: Date | null;
  retracted_at: Date | null;
  current_version_id: string | null;
}

type Query = Pick<pg.Pool, 'query'>;

export async function readSchedule(
  db: Query,
  orgId: string,
  contentId: string,
): Promise<Schedule | null> {
  const r = await db.query<Schedule>(
    'SELECT state, publish_at, expires_at, retracted_at, current_version_id FROM platform_content_schedule($1, $2)',
    [orgId, contentId],
  );
  return r.rows[0] ?? null;
}

/** Schedules the publish/expire transitions that are still ahead (or due now) for one content item. */
export async function scheduleTransitions(
  db: Query,
  ctx: JobContext,
  ev: DomainEvent,
): Promise<void> {
  const s = await readSchedule(db, ev.org_id, ev.subject_id);
  if (!s || s.state !== 'published' || s.retracted_at) return;
  const base = { orgId: ev.org_id, contentId: ev.subject_id };
  const defer = async (kind: 'publish' | 'expire', when: Date) => {
    const at = when.toISOString();
    await ctx.queue.send(
      QUEUES.contentTransition,
      { ...base, kind, at },
      {
        singletonKey: `${kind}:${ev.subject_id}:${at}`,
        startAfter: when,
        retentionSeconds: retentionFor(when, ctx.now()),
      },
    );
  };
  if (s.publish_at) await defer('publish', s.publish_at);
  if (s.expires_at) await defer('expire', s.expires_at);
}

const DEFAULT_RETENTION_S = 14 * 24 * 3600; // pg-boss deletes queued jobs after retentionSeconds (default 14 d)

/** A deferred job must outlive its own startAfter, or pg-boss drops it before it ever runs. */
export function retentionFor(startAfter: Date, now: Date): number {
  const wait = Math.max(0, Math.ceil((startAfter.getTime() - now.getTime()) / 1000));
  return wait + DEFAULT_RETENTION_S;
}

export interface FanOutResult {
  recipients: number;
  inserted: number;
}

async function notifyAll(
  db: Query,
  orgId: string,
  rows: { user_id: string; title: string | null }[],
  args: {
    kind: string;
    reason: string;
    contentId: string;
    versionId: string | null;
    dedupe: string;
  },
): Promise<FanOutResult> {
  let inserted = 0;
  for (const r of rows) {
    const res = await db.query<{ inserted: boolean }>(
      'SELECT platform_notify($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) AS inserted',
      [
        orgId,
        r.user_id,
        args.kind,
        args.reason,
        args.contentId,
        args.versionId,
        r.title,
        args.dedupe,
        '{}',
      ],
    );
    if (res.rows[0]?.inserted) inserted += 1;
  }
  return { recipients: rows.length, inserted };
}

/** content.published → every member who can see the item now (reason `audience`). */
export async function fanOutPublished(db: Query, ev: DomainEvent): Promise<FanOutResult> {
  let versionId = ev.version_id;
  if (!versionId) {
    const s = await readSchedule(db, ev.org_id, ev.subject_id);
    versionId = s?.current_version_id ?? null;
  }
  if (!versionId) return { recipients: 0, inserted: 0 };
  const audience = await db.query<{ user_id: string }>(
    'SELECT user_id FROM platform_audience_of_content($1, $2)',
    [ev.org_id, ev.subject_id],
  );
  return notifyAll(
    db,
    ev.org_id,
    audience.rows.map((r) => ({ user_id: r.user_id, title: null })),
    {
      kind: 'content.published',
      reason: 'audience',
      contentId: ev.subject_id,
      versionId,
      dedupe: `published:${versionId}`,
    },
  );
}

/**
 * content.retracted → everyone who viewed that version (reason `saw_version`), as a neutral notice;
 * the view-time title snapshot travels only when the org opted in (ADR-0005 §2).
 */
export async function fanOutRetracted(db: Query, ev: DomainEvent): Promise<FanOutResult> {
  let versionId = ev.version_id;
  if (!versionId) {
    const s = await readSchedule(db, ev.org_id, ev.subject_id);
    versionId = s?.current_version_id ?? null;
  }
  if (!versionId) return { recipients: 0, inserted: 0 };
  const settings = await db.query<{ include_title_after_access_loss: boolean }>(
    'SELECT include_title_after_access_loss FROM platform_org_notify_settings($1)',
    [ev.org_id],
  );
  const includeTitle = settings.rows[0]?.include_title_after_access_loss === true;
  const viewers = await db.query<{ user_id: string; title_snapshot: string | null }>(
    'SELECT user_id, title_snapshot FROM platform_viewers_of_version($1, $2)',
    [ev.org_id, versionId],
  );
  return notifyAll(
    db,
    ev.org_id,
    viewers.rows.map((r) => ({
      user_id: r.user_id,
      title: includeTitle ? r.title_snapshot : null,
    })),
    {
      kind: 'content.retracted',
      reason: 'saw_version',
      contentId: ev.subject_id,
      versionId,
      dedupe: `retracted:${versionId}`,
    },
  );
}

/** Routes one event. Throws to leave the event unprocessed for the next drain. */
export async function dispatchEvent(db: Query, ctx: JobContext, ev: DomainEvent): Promise<string> {
  switch (ev.type) {
    case 'content.version_uploaded': {
      if (!ev.version_id) return 'skipped: no version_id';
      await ctx.queue.send(
        QUEUES.mediaProcess,
        { orgId: ev.org_id, contentId: ev.subject_id, versionId: ev.version_id },
        { singletonKey: `media:${ev.version_id}` },
      );
      return 'enqueued media.process';
    }
    case 'content.scheduled':
    case 'content.expiry_scheduled':
      await scheduleTransitions(db, ctx, ev);
      return 'scheduled transitions';
    case 'content.published': {
      const r = await fanOutPublished(db, ev);
      return `published fan-out: ${r.inserted}/${r.recipients}`;
    }
    case 'content.retracted': {
      const r = await fanOutRetracted(db, ev);
      return `retracted fan-out: ${r.inserted}/${r.recipients}`;
    }
    default:
      return 'ignored: no handler';
  }
}

/**
 * Drains platform.domain_event in id order under the platform role. Each event is dispatched inside
 * its own savepoint and marked processed on success; a failing event is logged and left for the next
 * drain without blocking the rest of the batch.
 */
/** Events failing this many drains are parked (processed_at stays NULL) instead of retried forever. */
export const MAX_EVENT_ATTEMPTS = 5;

export async function drainOnce(
  ctx: JobContext,
  limit = 100,
): Promise<{ processed: number; failed: number; parked: number }> {
  const client = await ctx.platformPool.connect();
  let processed = 0;
  let failed = 0;
  let parked = 0;
  try {
    await client.query('BEGIN');
    const r = await client.query<DomainEvent>(
      `SELECT id, org_id, type, subject_type, subject_id, version_id, payload
         FROM platform.domain_event WHERE processed_at IS NULL AND attempts < $2 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit, MAX_EVENT_ATTEMPTS],
    );
    for (const ev of r.rows) {
      await client.query('SAVEPOINT ev');
      try {
        const outcome = await dispatchEvent(client, ctx, ev);
        await client.query('UPDATE platform.domain_event SET processed_at = now() WHERE id = $1', [
          ev.id,
        ]);
        await client.query('RELEASE SAVEPOINT ev');
        processed += 1;
        ctx.log.info({ eventId: ev.id, orgId: ev.org_id, type: ev.type, outcome }, 'outbox event');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT ev');
        // Count the attempt so a poison event cannot starve newer ones (F4); after MAX_EVENT_ATTEMPTS it
        // stays unprocessed with its last error for an operator to inspect.
        const upd = await client.query<{ attempts: number }>(
          'UPDATE platform.domain_event SET attempts = attempts + 1, last_error = left($2, 500) WHERE id = $1 RETURNING attempts',
          [ev.id, (err as Error).message],
        );
        failed += 1;
        const attempts = upd.rows[0]?.attempts ?? 0;
        if (attempts >= MAX_EVENT_ATTEMPTS) {
          parked += 1;
          ctx.log.error(
            { eventId: ev.id, orgId: ev.org_id, type: ev.type, attempts },
            'outbox event parked after repeated failures; inspect last_error and reset attempts to requeue',
          );
          continue;
        }
        ctx.log.error(
          { eventId: ev.id, orgId: ev.org_id, type: ev.type, err: (err as Error).message },
          'outbox event failed; will retry on the next drain',
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { processed, failed, parked };
}

export const outboxDrain: Handler = async (_data, ctx) => {
  await drainOnce(ctx);
};
