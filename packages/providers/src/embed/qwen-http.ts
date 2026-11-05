// SPDX-License-Identifier: AGPL-3.0-only
// Self-hosted embedding service adapter: Qwen3-Embedding-0.6B (Apache-2.0, 1024 dimensions) served by
// Hugging Face text-embeddings-inference (Apache-2.0) through its OpenAI-compatible route
// `POST {baseUrl}/v1/embeddings {model, input: string[]}`. Any server speaking that route works.
// The adapter validates every vector (count, dimension, finite, non-zero) and never puts request text or the
// upstream body into an error (NEG-10).
import {
  DEFAULT_EMBED_MODEL,
  EMBED_DIMS,
  EmbedError,
  type EmbedInput,
  type EmbedProvider,
  type ProviderDescriptor,
} from '../types.js';

export const qwenHttpDescriptor: ProviderDescriptor = {
  id: 'embed-qwen-http',
  vendor: 'Qwen/Qwen3-Embedding',
  capability: 'embed',
  models: [{ id: DEFAULT_EMBED_MODEL, languages: ['multilingual'] }],
  regions: ['local'],
  retentionClass: 'self_hosted',
  trainingUse: 'never',
  requiresContract: false,
  residencyNotes:
    'Runs inside the deployment (compose profile `embeddings`, Helm `embeddings`); text never leaves the cluster network.',
  sourceUrl: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B',
  verifiedOn: '2026-11-04',
};

export const QUERY_INSTRUCTION =
  'Given a search query, retrieve relevant passages that answer the query';

export interface QwenHttpOptions {
  baseUrl: string;
  /** Model name the server loaded; also the pin model this provider serves. */
  model?: string;
  timeoutMs?: number;
  /** Texts per request (the server batches internally; keeps one request bounded). */
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

const norm = (v: number[]) => Math.sqrt(v.reduce((n, x) => n + x * x, 0));

export function createQwenHttpEmbed(opts: QwenHttpOptions): EmbedProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const model = opts.model ?? DEFAULT_EMBED_MODEL;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const batch = opts.batchSize ?? 32;
  const doFetch = opts.fetchImpl ?? fetch;
  async function one(texts: string[]): Promise<number[][]> {
    let res: Response;
    try {
      res = await doFetch(`${base}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      throw new EmbedError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'upstream',
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined); // the body may echo the input; never read it
      throw new EmbedError('upstream', res.status);
    }
    let body: { data?: { embedding?: unknown; index?: number }[] };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new EmbedError('bad_response');
    }
    const data = body.data;
    if (!Array.isArray(data) || data.length !== texts.length) throw new EmbedError('bad_response');
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => {
      const e = d.embedding;
      if (!Array.isArray(e) || e.some((x) => typeof x !== 'number' || !Number.isFinite(x)))
        throw new EmbedError('bad_response');
      if (e.length !== EMBED_DIMS) throw new EmbedError('dims');
      if (!(norm(e as number[]) > 0)) throw new EmbedError('zero_vector');
      return e as number[];
    });
  }
  return {
    descriptor: qwenHttpDescriptor,
    model,
    dims: EMBED_DIMS,
    async embed(input: EmbedInput): Promise<number[][]> {
      const prefix = input.kind === 'query' ? `Instruct: ${QUERY_INSTRUCTION}\nQuery: ` : '';
      const texts = input.texts.map((t) => prefix + t);
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batch)
        out.push(...(await one(texts.slice(i, i + batch))));
      return out;
    },
  };
}
