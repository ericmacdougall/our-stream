// SPDX-License-Identifier: AGPL-3.0-only
// Scheduled maintenance under the platform role: raw engagement retention (decision Q12, per-org
// setting, default 13 months) in bounded batches, search-index hygiene (rows of non-current versions)
// and on-demand reindexing of one org (ADR-0013). Every call goes through an org-guarded definer function.
import { z } from 'zod';
import type { Handler, JobContext } from './jobs.js';

const PRUNE_BATCH = 5000;
const PRUNE_MAX_BATCHES = 20; // per org per run; the next run continues

export interface RetentionRun {
  orgs: number;
  deleted: number;
}

export async function runEngagementRetention(ctx: JobContext): Promise<RetentionRun> {
  const db = ctx.platformPool;
  const run: RetentionRun = { orgs: 0, deleted: 0 };
  const orgs = await db.query<{ id: string }>('SELECT platform_orgs() AS id');
  for (const { id: orgId } of orgs.rows) {
    run.orgs += 1;
    const days = await db.query<{ d: number }>('SELECT platform_org_retention($1) AS d', [orgId]);
    const before = new Date(ctx.now().getTime() - (days.rows[0]?.d ?? 395) * 86_400_000);
    for (let i = 0; i < PRUNE_MAX_BATCHES; i += 1) {
      const r = await db.query<{ n: number }>('SELECT platform_engagement_prune($1, $2, $3) AS n', [
        orgId,
        before,
        PRUNE_BATCH,
      ]);
      const n = r.rows[0]?.n ?? 0;
      run.deleted += n;
      if (n < PRUNE_BATCH) break;
    }
  }
  ctx.log.info(run, 'engagement retention run');
  return run;
}

export const engagementRetention: Handler = async (_data, ctx) => {
  await runEngagementRetention(ctx);
};

export async function runSearchPrune(ctx: JobContext): Promise<{ orgs: number; deleted: number }> {
  const db = ctx.platformPool;
  let deleted = 0;
  const orgs = await db.query<{ id: string }>('SELECT platform_orgs() AS id');
  for (const { id: orgId } of orgs.rows) {
    const r = await db.query<{ n: number }>('SELECT platform_search_prune($1) AS n', [orgId]);
    deleted += r.rows[0]?.n ?? 0;
  }
  ctx.log.info({ orgs: orgs.rows.length, deleted }, 'search prune run');
  return { orgs: orgs.rows.length, deleted };
}

export const searchPrune: Handler = async (_data, ctx) => {
  await runSearchPrune(ctx);
};

export const ReindexJob = z.object({ orgId: z.uuid() });

export const searchReindex: Handler = async (data, ctx) => {
  const job = ReindexJob.parse(data);
  const r = await ctx.platformPool.query<{ n: number }>('SELECT platform_search_reindex($1) AS n', [
    job.orgId,
  ]);
  ctx.log.info({ orgId: job.orgId, chunks: r.rows[0]?.n ?? 0 }, 'search reindex run');
};
