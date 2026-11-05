// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { EMBED_DIMS, EmbedError } from '../types.js';
import { createFakeEmbed, fakeVector, normalizeNonZero } from './fake.js';
import { createQwenHttpEmbed, QUERY_INSTRUCTION } from './qwen-http.js';
import { createEmbedProviderFromEnv } from './from-env.js';

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] as number), 0);

describe('fake embedder', () => {
  it('is deterministic, unit length, 1024-dimensional and never the zero vector', async () => {
    const p = createFakeEmbed();
    const inputs = [
      '',
      ' ',
      '\u0000',
      'a',
      'The quick brown fox',
      '\ud800 lone',
      '日本語のテキスト',
      'x'.repeat(10_000),
    ];
    const [a, b] = [await p.embed({ texts: inputs }), await p.embed({ texts: inputs })];
    expect(a).toEqual(b);
    for (const v of a) {
      expect(v).toHaveLength(EMBED_DIMS);
      expect(v.every(Number.isFinite)).toBe(true);
      expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    }
    expect(a.length).toBe(inputs.length);
  });

  it('an all-zero accumulator becomes a unit vector, never a zero vector', () => {
    const v = normalizeNonZero(new Float64Array(EMBED_DIMS));
    expect(v[0]).toBe(1);
    expect(v.reduce((s, x) => s + x * x, 0)).toBe(1);
    expect(normalizeNonZero(new Float64Array(EMBED_DIMS).fill(Number.NaN))[0]).toBe(1);
  });

  it('texts sharing words are closer than unrelated texts (so retrieval tests can check relevance)', () => {
    const q = fakeVector('quarterly revenue report');
    expect(cos(q, fakeVector('revenue report for the quarter'))).toBeGreaterThan(
      cos(q, fakeVector('cat dog bird')),
    );
  });

  it('two fake models give different vectors for the same text (shadow pin stand-in)', async () => {
    const [a, b] = [createFakeEmbed(), createFakeEmbed({ model: 'fake-b' })];
    expect((await a.embed({ texts: ['same'] }))[0]).not.toEqual(
      (await b.embed({ texts: ['same'] }))[0],
    );
    expect(b.model).toBe('fake-b');
  });

  it('is the default only when no provider is configured, and rejects unknown names', () => {
    expect(createEmbedProviderFromEnv({}).descriptor.id).toBe('embed-fake');
    expect(() => createEmbedProviderFromEnv({ EMBED_PROVIDER: 'openai' })).toThrow(
      /one of fake, qwen-http/,
    );
    expect(createEmbedProviderFromEnv({ EMBED_PROVIDER: 'qwen-http' }).descriptor.id).toBe(
      'embed-qwen-http',
    );
  });
});

const vec = (x: number) => Array.from({ length: EMBED_DIMS }, (_, i) => (i === 0 ? x : 0));

describe('qwen-http adapter', () => {
  const resp = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

  it('posts to the OpenAI-compatible route, batches, restores order and prefixes queries', async () => {
    const seen: { url: string; body: { input: string[]; model: string } }[] = [];
    const p = createQwenHttpEmbed({
      baseUrl: 'http://embeddings:80/',
      batchSize: 2,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        seen.push({ url: String(url), body });
        // reversed index order: the adapter must sort by index
        return resp({
          data: body.input
            .map((_: string, i: number) => ({ index: i, embedding: vec(i + 1) }))
            .reverse(),
        });
      },
    });
    const out = await p.embed({ texts: ['a', 'b', 'c'], kind: 'query' });
    expect(out.map((v) => v[0])).toEqual([1, 2, 1]);
    expect(seen.map((s) => s.url)).toEqual([
      'http://embeddings:80/v1/embeddings',
      'http://embeddings:80/v1/embeddings',
    ]);
    expect(seen[0]?.body.input[0]).toBe(`Instruct: ${QUERY_INSTRUCTION}\nQuery: a`);
    expect(seen[0]?.body.model).toBe('Qwen3-Embedding-0.6B');
    const doc = await createQwenHttpEmbed({
      baseUrl: 'http://x',
      fetchImpl: async (_u, init) =>
        resp({
          data: JSON.parse(String(init?.body)).input.map((_: string, i: number) => ({
            index: i,
            embedding: vec(1),
          })),
        }),
    }).embed({ texts: ['plain'] });
    expect(doc).toHaveLength(1);
  });

  it('refuses wrong dimensions, zero vectors, NaN, wrong counts and malformed bodies', async () => {
    const mk = (data: unknown) =>
      createQwenHttpEmbed({ baseUrl: 'http://x', fetchImpl: async () => resp(data) });
    const codeOf = async (p: ReturnType<typeof mk>) => {
      try {
        await p.embed({ texts: ['t'] });
        return 'no error';
      } catch (e) {
        return (e as EmbedError).code;
      }
    };
    expect(await codeOf(mk({ data: [{ index: 0, embedding: [1, 2, 3] }] }))).toBe('dims');
    expect(await codeOf(mk({ data: [{ index: 0, embedding: vec(0) }] }))).toBe('zero_vector');
    expect(
      await codeOf(
        mk({ data: [{ index: 0, embedding: vec(1).map((x, i) => (i === 5 ? Number.NaN : x)) }] }),
      ),
    ).toBe('bad_response');
    expect(await codeOf(mk({ data: [] }))).toBe('bad_response');
    expect(await codeOf(mk({}))).toBe('bad_response');
    expect(await codeOf(mk({ data: [{ index: 0, embedding: vec(1) }] }))).toBe('no error');
  });

  it('NEG-10: an upstream error that echoes the input is never copied into the error', async () => {
    const canary = 'CANARY-SECRET-CHUNK-TEXT-7731';
    const p = createQwenHttpEmbed({
      baseUrl: 'http://x',
      fetchImpl: async (_u, init) =>
        new Response(JSON.stringify({ error: `bad input: ${String(init?.body)}` }), {
          status: 500,
        }),
    });
    const err = await p.embed({ texts: [canary] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(EmbedError);
    const e = err as EmbedError;
    expect(e.message).toBe('embed failed: upstream (http 500)');
    expect(JSON.stringify({ message: e.message, stack: e.stack, e })).not.toContain(canary);
    const network = await createQwenHttpEmbed({
      baseUrl: 'http://x',
      fetchImpl: async (_u, init) => {
        throw new Error(`ECONNRESET while sending ${String(init?.body)}`);
      },
    })
      .embed({ texts: [canary] })
      .catch((e: Error) => e);
    expect((network as EmbedError).code).toBe('upstream');
    expect((network as Error).message).not.toContain(canary);
    expect(((network as Error).cause as unknown) ?? null).toBeNull();
  });

  it('times out with a timeout code', async () => {
    const p = createQwenHttpEmbed({
      baseUrl: 'http://x',
      timeoutMs: 20,
      fetchImpl: (_u, init) =>
        new Promise((_r, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('x'), { name: 'TimeoutError' })),
          ),
        ),
    });
    expect(((await p.embed({ texts: ['a'] }).catch((e: Error) => e)) as EmbedError).code).toBe(
      'timeout',
    );
  });
});
