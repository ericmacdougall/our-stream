// SPDX-License-Identifier: AGPL-3.0-only
// media.process: version brief → pipeline (download, probe, transcode, thumbnails, asr, captions,
// upload) → platform_version_update(status 'current'), which also flips content.current_version_id.
// Failures persist status 'failed' with a redacted message; pg-boss retries with backoff (3 attempts).
import { PipelineError, runMediaPipeline, type PipelineStep } from '@our-stream/pipeline';
import { z } from 'zod';
import type { Handler, JobContext } from './jobs.js';

export const MediaJob = z.object({ orgId: z.uuid(), contentId: z.uuid(), versionId: z.uuid() });
export type MediaJob = z.infer<typeof MediaJob>;

interface VersionBrief {
  content_id: string;
  status: 'uploaded' | 'processing' | 'current' | 'superseded' | 'retracted' | 'failed';
  original_key: string | null;
  mime_type: string | null;
  assets: unknown;
  language: string | null;
}

export function derivedPrefix(job: MediaJob): string {
  return `orgs/${job.orgId}/content/${job.contentId}/versions/${job.versionId}/derived`;
}

async function updateVersion(
  ctx: JobContext,
  job: MediaJob,
  patch: {
    status: 'processing' | 'current' | 'failed' | null;
    step: string | null;
    error: string | null;
    assets?: unknown;
    transcript?: unknown;
    meta?: unknown;
  },
): Promise<void> {
  await ctx.platformPool.query(
    'SELECT platform_version_update($1, $2, $3::version_status, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)',
    [
      job.orgId,
      job.versionId,
      patch.status,
      patch.step,
      patch.error,
      patch.assets === undefined ? null : JSON.stringify(patch.assets),
      patch.transcript === undefined ? null : JSON.stringify(patch.transcript),
      patch.meta === undefined ? null : JSON.stringify(patch.meta),
    ],
  );
}

export class MediaJobError extends Error {
  constructor(
    public readonly publicMessage: string,
    public readonly step: PipelineStep | 'brief',
    cause?: unknown,
  ) {
    super(`${step}: ${publicMessage}`, { cause });
    this.name = 'MediaJobError';
  }
}

export const mediaProcess: Handler = async (data, ctx) => {
  const job = MediaJob.parse(data);
  const log = { orgId: job.orgId, contentId: job.contentId, versionId: job.versionId };
  const briefRes = await ctx.platformPool.query<VersionBrief>(
    'SELECT content_id, status, original_key, mime_type, assets, language FROM platform_version_brief($1, $2)',
    [job.orgId, job.versionId],
  );
  const brief = briefRes.rows[0];
  if (!brief || brief.content_id !== job.contentId) {
    // Nothing to mark: a version that does not belong to this org/content is not ours to update.
    ctx.log.warn(log, 'media.process: version not found for org/content; dropping job');
    return;
  }
  if (brief.status === 'retracted' || brief.status === 'superseded') {
    ctx.log.info({ ...log, status: brief.status }, 'media.process: version no longer processable');
    return;
  }
  if (!brief.original_key) {
    await updateVersion(ctx, job, {
      status: 'failed',
      step: 'brief',
      error: 'original upload missing',
    });
    throw new MediaJobError('original upload missing', 'brief');
  }

  let lastStep: PipelineStep | 'brief' = 'brief';
  try {
    const result = await runMediaPipeline(
      {
        originalKey: brief.original_key,
        derivedPrefix: derivedPrefix(job),
        ...(brief.language ? { language: brief.language } : {}),
      },
      {
        store: ctx.store,
        asr: ctx.asr,
        limits: ctx.limits,
        onStep: async (step) => {
          lastStep = step;
          ctx.log.info({ ...log, step }, 'media.process step');
          await updateVersion(ctx, job, { status: 'processing', step, error: null });
        },
      },
    );
    await updateVersion(ctx, job, {
      status: 'current',
      step: 'done',
      error: null,
      assets: result.assets,
      transcript: result.transcript,
      meta: result.meta,
    });
    ctx.log.info(
      {
        ...log,
        renditions: result.assets.hls.renditions.map((r) => r.name),
        captions: Object.keys(result.assets.captions),
        derivedKeys: result.derivedKeys.length,
        durationMs: result.meta.duration_ms,
      },
      'media.process done',
    );
  } catch (err) {
    const publicMessage = err instanceof PipelineError ? err.publicMessage : 'unexpected error';
    const step = err instanceof PipelineError ? err.step : lastStep;
    ctx.log.error({ ...log, step, err: (err as Error).message }, 'media.process failed');
    await updateVersion(ctx, job, { status: 'failed', step, error: `${step}: ${publicMessage}` });
    throw new MediaJobError(publicMessage, step, err);
  }
};
