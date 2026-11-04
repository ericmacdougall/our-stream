// SPDX-License-Identifier: AGPL-3.0-only
// Time-driven transition (ADR-0003/0004): at publish_at or expires_at, bump the content epoch and the
// org sequence; for publish, write the content.published outbox row. The job re-reads the schedule so a
// rescheduled or retracted item makes an earlier job a no-op instead of a premature notification.
import { z } from 'zod';
import type { Handler } from './jobs.js';
import { readSchedule } from './outbox.js';

export const TransitionJob = z.object({
  orgId: z.uuid(),
  contentId: z.uuid(),
  kind: z.enum(['publish', 'expire']),
  /** ISO instant this job was scheduled for; must still match the row. */
  at: z.iso.datetime(),
});

export const contentTransition: Handler = async (data, ctx) => {
  const job = TransitionJob.parse(data);
  const s = await readSchedule(ctx.platformPool, job.orgId, job.contentId);
  const now = ctx.now();
  const scheduledFor = new Date(job.at);
  const reason = (() => {
    if (!s) return 'content missing';
    if (s.state !== 'published' || s.retracted_at) return `state ${s.state}`;
    const target = job.kind === 'publish' ? s.publish_at : s.expires_at;
    if (!target) return 'no longer scheduled';
    if (target.getTime() !== scheduledFor.getTime()) return 'rescheduled';
    if (target.getTime() > now.getTime()) return 'not due yet';
    return null;
  })();
  if (reason) {
    ctx.log.info({ ...job, reason }, 'transition skipped');
    return;
  }
  await ctx.platformPool.query('SELECT platform_content_transition($1, $2, $3)', [
    job.orgId,
    job.contentId,
    job.kind,
  ]);
  ctx.log.info(
    { orgId: job.orgId, contentId: job.contentId, kind: job.kind },
    'transition applied',
  );
};
