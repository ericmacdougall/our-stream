// SPDX-License-Identifier: AGPL-3.0-only
// Embedding jobs (M2a AC-3). Vectors are keyed by (org, text hash, pin); the worker never derives a hash and
// never carries chunk text in a job payload or a log: it asks the database for the hashes missing under the
// pin, fetches their text through platform_embedding_chunk_text, embeds, and writes through
// platform_embedding_upsert. Every step is idempotent, so a killed worker simply resumes.
//
// Policy: the ONE call site of EmbedProvider.embed is `embedTexts` below, reached only through
// selectProvider(policy, [the provider pinned to the model], 'embed'). With a single candidate there is no
// fallback: a refusal means no vector is written (retrieval stays keyword-only for that text).
import {
  EmbedError,
  ProviderPolicyError,
  selectProvider,
  type EmbedProvider,
  type OrgModelPolicy,
} from '@our-stream/providers';
import type { Handler, JobContext, Logger } from '../jobs.js';

export interface EmbedRuntime {
  policy: OrgModelPolicy;
  /** Every configured embedder; one is picked per pin by model name (no cross-model fallback). */
  providers: readonly EmbedProvider[];
  /** Texts per provider call. */
  batchSize?: number;
  /** Hashes per reconcile scan and per org and run. */
  scanLimit?: number;
}

export interface Pin {
  id: string;
  model: string;
  dims: number;
}

/** Fixed-message job failure: nothing from the text, the provider or the database travels into pg-boss. */
export class EmbedJobError extends Error {
  constructor(public readonly code: string) {
    super(`embed job failed: ${code}`);
    this.name = 'EmbedJobError';
  }
}

export type EmbedOutcome =
  | { status: 'embedded'; written: number; embedCalls: number; texts: number }
  | { status: 'refused'; reason: string }
  | { status: 'no_provider' };

const asBuffer = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'hex'));

export async function activePin(ctx: JobContext): Promise<Pin> {
  const r = await ctx.platformPool.query<Pin>(
    'SELECT id, model, dims FROM platform_embedding_active_pin()',
  );
  const pin = r.rows[0];
  if (!pin) throw new EmbedJobError('no_active_pin');
  return pin;
}

/**
 * Picks the provider for a pin through the policy router. Returns null on a policy refusal (logged without
 * text) and throws when no provider is configured for the pin's model.
 */
export function providerForPin(
  runtime: EmbedRuntime,
  pin: Pin,
  log: Logger,
): { provider: EmbedProvider } | { refused: string } | null {
  const candidates = runtime.providers.filter((p) => p.model === pin.model && p.dims === pin.dims);
  if (candidates.length === 0) return null;
  try {
    // Exactly one candidate is offered: the router can refuse it, never substitute another provider.
    return { provider: selectProvider(runtime.policy, candidates.slice(0, 1), 'embed') };
  } catch (err) {
    if (err instanceof ProviderPolicyError) {
      log.warn(
        { pinId: pin.id, provider: err.providerId, reason: err.reason },
        'embed refused by provider policy',
      );
      return { refused: err.reason };
    }
    throw err;
  }
}

/** The single `embed` call site (see the header). */
async function embedTexts(provider: EmbedProvider, texts: string[]): Promise<number[][]> {
  const vectors = await provider.embed({ texts, kind: 'document' });
  if (vectors.length !== texts.length) throw new EmbedJobError('provider_count');
  return vectors;
}

/**
 * Embeds the given hashes for one org under one pin. Hashes come from the database; texts are fetched,
 * embedded in batches and upserted. Idempotent and resumable.
 */
export async function fillHashes(
  ctx: JobContext,
  runtime: EmbedRuntime,
  orgId: string,
  pin: Pin,
  hashes: Buffer[],
): Promise<EmbedOutcome> {
  if (hashes.length === 0) return { status: 'embedded', written: 0, embedCalls: 0, texts: 0 };
  const picked = providerForPin(runtime, pin, ctx.log);
  if (picked === null) return { status: 'no_provider' };
  if ('refused' in picked) return { status: 'refused', reason: picked.refused };
  const { provider } = picked;
  const batch = Math.max(1, Math.min(runtime.batchSize ?? 16, 200));
  let written = 0;
  let embedCalls = 0;
  let texts = 0;
  for (let i = 0; i < hashes.length; i += batch) {
    const slice = hashes.slice(i, i + batch);
    const rows = await ctx.platformPool.query<{ text_sha256: Buffer; text: string }>(
      'SELECT text_sha256, text FROM platform_embedding_chunk_text($1, $2::bytea[])',
      [orgId, slice],
    );
    if (rows.rows.length === 0) continue; // flag off, or the chunks are gone: nothing to embed
    let vectors: number[][];
    try {
      embedCalls += 1;
      texts += rows.rows.length;
      vectors = await embedTexts(
        provider,
        rows.rows.map((r) => r.text),
      );
    } catch (err) {
      // Whatever the provider said (it may echo its input), only a fixed code leaves this function.
      throw new EmbedJobError(
        err instanceof EmbedError ? err.code : err instanceof EmbedJobError ? err.code : 'provider',
      );
    }
    for (let k = 0; k < rows.rows.length; k += 1) {
      const row = rows.rows[k] as { text_sha256: Buffer };
      const up = await ctx.platformPool.query<{ ok: boolean }>(
        'SELECT platform_embedding_upsert($1, $2, $3, $4::vector) AS ok',
        [orgId, row.text_sha256, pin.id, JSON.stringify(vectors[k])],
      );
      if (up.rows[0]?.ok) written += 1;
    }
  }
  return { status: 'embedded', written, embedCalls, texts };
}

async function missingForVersion(
  ctx: JobContext,
  orgId: string,
  versionId: string,
  pinId: string,
): Promise<Buffer[]> {
  const r = await ctx.platformPool.query<{ h: unknown }>(
    'SELECT platform_embedding_missing_hashes($1, $2, $3) AS h',
    [orgId, versionId, pinId],
  );
  return r.rows.map((x) => asBuffer(x.h));
}

/** embed.version: fill the active pin for one version's chunks (enqueued after a document finishes). */
export const embedVersion: Handler = async (data, ctx) => {
  const { orgId, versionId } = parseVersionJob(data);
  const runtime = requireRuntime(ctx);
  const pin = await activePin(ctx);
  const out = await fillHashes(
    ctx,
    runtime,
    orgId,
    pin,
    await missingForVersion(ctx, orgId, versionId, pin.id),
  );
  ctx.log.info({ orgId, versionId, pinId: pin.id, ...summary(out) }, 'embed.version');
};

export function requireRuntime(ctx: JobContext): EmbedRuntime {
  if (!ctx.embed) throw new EmbedJobError('not_configured');
  return ctx.embed;
}

function parseVersionJob(data: unknown): { orgId: string; versionId: string } {
  const d = data as { orgId?: unknown; versionId?: unknown };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    typeof d?.orgId !== 'string' ||
    !uuid.test(d.orgId) ||
    typeof d.versionId !== 'string' ||
    !uuid.test(d.versionId)
  )
    throw new EmbedJobError('bad_payload');
  return { orgId: d.orgId, versionId: d.versionId };
}

export function summary(o: EmbedOutcome): Record<string, unknown> {
  return o.status === 'embedded'
    ? { status: o.status, written: o.written, embedCalls: o.embedCalls, texts: o.texts }
    : o.status === 'refused'
      ? { status: o.status, reason: o.reason }
      : { status: o.status };
}

export interface OrgReadiness {
  orgId: string;
  total: number;
  covered: number;
  ready: boolean;
}

export async function listOrgs(ctx: JobContext): Promise<string[]> {
  const r = await ctx.platformPool.query<{ id: string }>('SELECT platform_orgs() AS id');
  return r.rows.map((x) => x.id);
}

/** Per-org coverage under a pin: ready when every chunk hash of a current version has a vector. */
export async function orgReadiness(
  ctx: JobContext,
  orgId: string,
  pinId: string,
): Promise<OrgReadiness> {
  const r = await ctx.platformPool.query<{ total: string; covered: string }>(
    'SELECT total, covered FROM platform_embedding_coverage($1, $2)',
    [orgId, pinId],
  );
  const total = Number(r.rows[0]?.total ?? 0);
  const covered = Number(r.rows[0]?.covered ?? 0);
  return { orgId, total, covered, ready: covered >= total };
}

export interface ReconcileReport {
  pinId: string;
  orgs: (OrgReadiness & { gcRemoved: number; embedded: number; status: string })[];
}

/**
 * embed.reconcile: for every org, garbage-collect vectors no chunk references, then embed what is missing
 * under the active pin (this covers a parse whose vectors were lost to a concurrent garbage collection, and
 * the backfill of existing clip chunks) and report per-org readiness. Nothing runs for an org with documents
 * disabled (the database functions return nothing), so the clip backfill pauses with the flag.
 */
export async function reconcileOnce(ctx: JobContext, pin?: Pin): Promise<ReconcileReport> {
  const runtime = requireRuntime(ctx);
  const target = pin ?? (await activePin(ctx));
  const report: ReconcileReport = { pinId: target.id, orgs: [] };
  const limit = runtime.scanLimit ?? 500;
  for (const orgId of await listOrgs(ctx)) {
    const gc = await ctx.platformPool.query<{ n: number }>(
      'SELECT platform_embedding_gc($1) AS n',
      [orgId],
    );
    const missing = await ctx.platformPool.query<{ h: unknown }>(
      'SELECT platform_embedding_reconcile($1, $2, $3) AS h',
      [orgId, target.id, limit],
    );
    const out = await fillHashes(
      ctx,
      runtime,
      orgId,
      target,
      missing.rows.map((x) => asBuffer(x.h)),
    );
    const ready = await orgReadiness(ctx, orgId, target.id);
    report.orgs.push({
      ...ready,
      gcRemoved: Number(gc.rows[0]?.n ?? 0),
      embedded: out.status === 'embedded' ? out.written : 0,
      status: out.status,
    });
    ctx.log.info(
      {
        orgId,
        pinId: target.id,
        total: ready.total,
        covered: ready.covered,
        ready: ready.ready,
        ...summary(out),
      },
      'embed.reconcile org',
    );
  }
  return report;
}

export const embedReconcile: Handler = async (_data, ctx) => {
  await reconcileOnce(ctx);
};
