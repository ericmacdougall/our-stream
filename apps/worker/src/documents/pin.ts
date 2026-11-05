// SPDX-License-Identifier: AGPL-3.0-only
// Shadow pin flow (AC-3): a same-dimension model swap fills a shadow pin while retrieval stays on the active
// pin, then switches atomically. Index creation needs the admin role and runs in the pin-index CLI
// (pin-cli.ts); the worker runs fill, readiness and switch under the platform role. The switch itself
// (platform_embedding_pin_switch) refuses unless the readiness row says the index is VALID and coverage is
// complete and fresh, so a skipped or failed step can never promote a half-filled pin.
import { pinIndexName } from '@our-stream/db';
import { z } from 'zod';
import type { Handler, JobContext } from '../jobs.js';
import {
  EmbedJobError,
  fillHashes,
  listOrgs,
  orgReadiness,
  requireRuntime,
  type Pin,
} from './embed.js';

export const PinJob = z.object({
  action: z.enum(['fill', 'ready', 'switch', 'advance']),
  pinId: z.uuid(),
  /** Model name of the pin (the registry picks the provider by it). Not secret. */
  model: z.string().min(1).max(200),
  /** `advance` only: switch once the pin is ready. */
  switch: z.boolean().optional(),
});
export type PinJob = z.infer<typeof PinJob>;

const MAX_ROUNDS = 10_000;

/** Embeds every missing hash of every org under the pin; returns how many vectors were written. */
export async function fillPin(
  ctx: JobContext,
  pin: Pin,
): Promise<{ written: number; embedCalls: number }> {
  const runtime = requireRuntime(ctx);
  const limit = runtime.scanLimit ?? 500;
  let written = 0;
  let embedCalls = 0;
  for (const orgId of await listOrgs(ctx)) {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const r = await ctx.platformPool.query<{ h: Buffer }>(
        'SELECT platform_embedding_reconcile($1, $2, $3) AS h',
        [orgId, pin.id, limit],
      );
      if (r.rows.length === 0) break;
      const out = await fillHashes(
        ctx,
        runtime,
        orgId,
        pin,
        r.rows.map((x) => x.h),
      );
      if (out.status !== 'embedded') throw new EmbedJobError(`fill_${out.status}`);
      written += out.written;
      embedCalls += out.embedCalls;
      if (out.written === 0) break; // nothing new could be written: do not spin
    }
  }
  return { written, embedCalls };
}

export async function indexIsValid(ctx: JobContext, pinId: string): Promise<boolean> {
  const r = await ctx.platformPool.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`,
    [pinIndexName(pinId)],
  );
  return r.rows[0]?.valid === true;
}

/** Checks per-org coverage and the index, then writes the platform readiness row. */
export async function markReady(
  ctx: JobContext,
  pinId: string,
): Promise<{ indexValid: boolean; coverageComplete: boolean; total: number; covered: number }> {
  let total = 0;
  let covered = 0;
  for (const orgId of await listOrgs(ctx)) {
    const r = await orgReadiness(ctx, orgId, pinId);
    total += r.total;
    covered += r.covered;
  }
  const indexValid = await indexIsValid(ctx, pinId);
  const coverageComplete = covered >= total;
  await ctx.platformPool.query('SELECT platform_embedding_pin_ready($1, $2, $3)', [
    pinId,
    indexValid,
    coverageComplete,
  ]);
  return { indexValid, coverageComplete, total, covered };
}

export async function switchPin(ctx: JobContext, pinId: string): Promise<void> {
  await ctx.platformPool.query('SELECT platform_embedding_pin_switch($1)', [pinId]);
}

export const embedPin: Handler = async (data, ctx) => {
  const j = PinJob.parse(data);
  const pin: Pin = { id: j.pinId, model: j.model, dims: 1024 };
  const info: Record<string, unknown> = { pinId: j.pinId, action: j.action };
  if (j.action === 'fill' || j.action === 'advance') Object.assign(info, await fillPin(ctx, pin));
  if (j.action === 'ready' || j.action === 'advance')
    Object.assign(info, await markReady(ctx, j.pinId));
  if (j.action === 'switch' || (j.action === 'advance' && j.switch === true)) {
    if (
      j.action === 'advance' &&
      !(info['indexValid'] === true && info['coverageComplete'] === true)
    ) {
      ctx.log.warn(info, 'embed.pin: not ready; not switching');
      return;
    }
    await switchPin(ctx, j.pinId);
    info['switched'] = true;
  }
  ctx.log.info(info, 'embed.pin');
};
