// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic embedder for CI and development. Vectors are a normalised sum of per-word pseudo-random
// vectors, so texts that share words are closer (retrieval tests can check relevance) and the same text
// always gives the same vector. It never emits a zero vector (pgvector skips zero vectors in cosine HNSW).
// It reports the default pin's model name so CI can fill the default pin without a model server; it is not
// semantic and must not run in production (the worker refuses it there unless explicitly allowed).
import { createHash } from 'node:crypto';
import {
  DEFAULT_EMBED_MODEL,
  EMBED_DIMS,
  type EmbedInput,
  type EmbedProvider,
  type ProviderDescriptor,
} from '../types.js';

export const fakeEmbedDescriptor: ProviderDescriptor = {
  id: 'embed-fake',
  vendor: 'our-stream',
  capability: 'embed',
  models: [{ id: 'fake' }],
  regions: ['local'],
  retentionClass: 'self_hosted',
  trainingUse: 'never',
  requiresContract: false,
  residencyNotes: 'In-process; no data leaves the worker.',
  sourceUrl: 'https://github.com/ericmacdougall/our-stream',
  verifiedOn: '2026-11-04',
};

function wordVector(word: string, out: Float64Array): void {
  // 128 bytes of SHA-256 chain -> 1024 signed components in [-1, 1).
  let block = createHash('sha256').update(word, 'utf8').digest();
  for (let i = 0; i < EMBED_DIMS; i += 32) {
    for (let j = 0; j < 32; j += 1)
      out[i + j] = (out[i + j] ?? 0) + ((block[j] as number) - 127.5) / 127.5;
    block = createHash('sha256').update(block).digest();
  }
}

export function fakeVector(text: string): number[] {
  const acc = new Float64Array(EMBED_DIMS);
  const words =
    text
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) wordVector(`\u0000empty:${text}`, acc);
  for (const w of words) wordVector(w, acc);
  return normalizeNonZero(acc);
}

/** Unit-length copy of `acc`; an all-zero (or non-finite) accumulator becomes the first basis vector, never zero. */
export function normalizeNonZero(acc: Float64Array): number[] {
  let norm = 0;
  for (const v of acc) norm += v * v;
  norm = Math.sqrt(norm);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    const unit = new Array<number>(EMBED_DIMS).fill(0);
    unit[0] = 1;
    return unit;
  }
  return Array.from(acc, (v) => v / norm);
}

export interface FakeEmbedOptions {
  /** Pin model name to report (default: the default pin's model). A second fake with another name stands in for a shadow pin. */
  model?: string;
  /** Called with the batch size on every embed call (tests count calls and texts). */
  onCall?: (texts: readonly string[]) => void;
}

export function createFakeEmbed(opts: FakeEmbedOptions = {}): EmbedProvider {
  const model = opts.model ?? DEFAULT_EMBED_MODEL;
  return {
    descriptor: fakeEmbedDescriptor,
    model,
    dims: EMBED_DIMS,
    async embed(input: EmbedInput): Promise<number[][]> {
      opts.onCall?.(input.texts);
      // The model name is mixed in so two fake "models" produce different vectors for the same text.
      const salt = model === DEFAULT_EMBED_MODEL ? '' : `${model}\u0001`;
      return input.texts.map((t) => fakeVector(salt + t));
    },
  };
}
