// SPDX-License-Identifier: AGPL-3.0-only
// Query embedding seam. The worker slice adds the `embed` capability to packages/providers (and its policy
// router refuses non-self-hosted providers, NEG-8). Until it lands, the API only needs this minimal
// interface; the integration point is `RetrievalOptions.embedder` in routes/retrieval.ts, to be wired to a
// `selectProvider('embed')`-backed adapter. A refusal must throw EmbedRefusedError and never fall back.
import { EMBED_TIMEOUT_MS } from './constants.js';

export interface QueryEmbedder {
  /** Model name; must equal the active pin's model or the vector leg is skipped (vectors of another model are meaningless). */
  readonly model: string;
  embed(text: string, signal: AbortSignal): Promise<ArrayLike<number>>;
}

export class EmbedRefusedError extends Error {
  constructor(message = 'embed refused by provider policy') {
    super(message);
    this.name = 'EmbedRefusedError';
  }
}

export type EmbedOutcome =
  | { ok: true; vector: number[] }
  | { ok: false; reason: 'embed_unavailable' | 'embed_timeout' | 'embed_refused' };

/** Embeds with a hard timeout; any failure degrades to keyword-only and never throws. */
export async function embedWithTimeout(
  embedder: QueryEmbedder | null,
  text: string,
  timeoutMs = EMBED_TIMEOUT_MS,
): Promise<EmbedOutcome> {
  if (!embedder) return { ok: false, reason: 'embed_unavailable' };
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort();
        resolve('timeout');
      }, timeoutMs);
    });
    const raced = await Promise.race([
      embedder.embed(text, ctl.signal).then(
        (v) => ({ v }),
        (e: unknown) => ({ e }),
      ),
      timeout,
    ]);
    if (raced === 'timeout') return { ok: false, reason: 'embed_timeout' };
    if ('e' in raced) {
      return {
        ok: false,
        reason: raced.e instanceof EmbedRefusedError ? 'embed_refused' : 'embed_unavailable',
      };
    }
    const vector = Array.from(raced.v);
    if (vector.length === 0 || vector.some((x) => !Number.isFinite(x)))
      return { ok: false, reason: 'embed_unavailable' };
    // A zero vector would never match in a cosine index (pgvector skips it); treat it as unavailable.
    if (!vector.some((x) => x !== 0)) return { ok: false, reason: 'embed_unavailable' };
    return { ok: true, vector };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
