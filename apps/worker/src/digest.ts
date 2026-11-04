// SPDX-License-Identifier: AGPL-3.0-only
// Daily email digest (ADR-0005 §5). At most one digest per member per day by construction: the
// database claim (platform_digest_claim) inserts the (org, user, day) row and marks the notifications
// digested in one call, so a second worker or a replayed job claims nothing. Titles are resolved by the
// database with readerVisible at build time (platform_digest_items), so a title the member can no longer
// see is never emailed. A failed send is retried on later runs of the same day (at most 3 attempts) and
// its items are re-resolved; a crash between a successful send and the mark can repeat one email, which
// is accepted and documented (docs/development.md); a claim left `pending` by a crash before the mark is
// retried after 30 minutes like a failed send (migration 0011).
import { z } from 'zod';
import { redactAddresses, renderDigest, type DigestItem } from '@our-stream/notifications';
import type { Handler, JobContext } from './jobs.js';

export const DigestJob = z.object({
  /** ISO date the digest covers; defaults to the worker's current UTC date. */
  day: z.iso.date().optional(),
});

interface Candidate {
  user_id: string;
  email: string;
  display_name: string;
  notification_ids: string[];
  items: DigestItem[];
}

export interface DigestRun {
  orgs: number;
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function deliver(
  ctx: JobContext,
  orgId: string,
  day: string,
  c: Candidate,
): Promise<boolean> {
  if (c.items.length === 0) {
    await ctx.platformPool.query('SELECT platform_digest_mark($1, $2, $3, true, NULL)', [
      orgId,
      c.user_id,
      day,
    ]);
    return true; // nothing left to say (items lost since the claim): close the row without a mail
  }
  const message = renderDigest({
    to: c.email,
    displayName: c.display_name,
    appBaseUrl: ctx.appBaseUrl,
    day,
    items: c.items,
  });
  try {
    await ctx.mailer.send(message);
  } catch (err) {
    const reason = redactAddresses((err as Error).message).slice(0, 300);
    await ctx.platformPool.query('SELECT platform_digest_mark($1, $2, $3, false, $4)', [
      orgId,
      c.user_id,
      day,
      reason,
    ]);
    ctx.log.error({ orgId, userId: c.user_id, day, err: reason }, 'digest send failed');
    return false;
  }
  await ctx.platformPool.query('SELECT platform_digest_mark($1, $2, $3, true, NULL)', [
    orgId,
    c.user_id,
    day,
  ]);
  return true;
}

export async function runDigest(ctx: JobContext, day = utcDay(ctx.now())): Promise<DigestRun> {
  const db = ctx.platformPool;
  const run: DigestRun = { orgs: 0, sent: 0, failed: 0, retried: 0, skipped: 0 };
  const orgs = await db.query<{ id: string }>('SELECT platform_orgs() AS id');
  for (const { id: orgId } of orgs.rows) {
    run.orgs += 1;
    // Failed sends from earlier runs today first (their items are re-resolved by the database).
    const retries = await db.query<Candidate>(
      'SELECT user_id, email, display_name, notification_ids, items FROM platform_digest_retry($1, $2)',
      [orgId, day],
    );
    for (const c of retries.rows) {
      run.retried += 1;
      if (await deliver(ctx, orgId, day, c)) run.sent += 1;
      else run.failed += 1;
    }
    const candidates = await db.query<Candidate>(
      'SELECT user_id, email, display_name, notification_ids, items FROM platform_digest_build($1, $2)',
      [orgId, day],
    );
    for (const c of candidates.rows) {
      const claimed = await db.query<{ ok: boolean }>(
        'SELECT platform_digest_claim($1, $2, $3, $4::uuid[]) AS ok',
        [orgId, c.user_id, day, c.notification_ids],
      );
      if (claimed.rows[0]?.ok !== true) {
        run.skipped += 1; // another worker claimed this member's digest for today
        continue;
      }
      if (await deliver(ctx, orgId, day, c)) run.sent += 1;
      else run.failed += 1;
    }
  }
  ctx.log.info(run, 'digest run');
  return run;
}

export const notifyDigest: Handler = async (data, ctx) => {
  const job = DigestJob.parse(data ?? {});
  await runDigest(ctx, job.day ?? utcDay(ctx.now()));
};
