// SPDX-License-Identifier: AGPL-3.0-only
// Embedding jobs against a scripted platform pool: the policy router is the only way to a provider, a refusal
// writes nothing, provider errors that echo their input are redacted, and a static scan proves there is one
// `.embed(` call site in the worker (NEG-8, NEG-10).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  DEFAULT_EMBED_MODEL,
  EmbedError,
  EMBED_DIMS,
  createFakeEmbed,
  fakeEmbedDescriptor,
  type EmbedProvider,
} from '@our-stream/providers';
import type { JobContext } from '../jobs.js';
import { EmbedJobError, fillHashes, providerForPin, type EmbedRuntime, type Pin } from './embed.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const PIN: Pin = {
  id: '5a7e0001-0000-4000-8000-000000000001',
  model: DEFAULT_EMBED_MODEL,
  dims: 1024,
};
const hashes = (n: number) => Array.from({ length: n }, (_, i) => Buffer.alloc(32, i + 1));

function pool(texts: Map<string, string>) {
  const upserts: { hash: string; pin: unknown; vector: number[] }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('platform_embedding_chunk_text'))
      rows = (params[1] as Buffer[])
        .map((h) => ({ text_sha256: h, text: texts.get(h.toString('hex')) ?? '' }))
        .filter((r) => r['text']);
    if (sql.includes('platform_embedding_upsert')) {
      upserts.push({
        hash: (params[1] as Buffer).toString('hex'),
        pin: params[2],
        vector: JSON.parse(String(params[3])),
      });
      rows = [{ ok: true }];
    }
    return { rows, rowCount: rows.length } as unknown as pg.QueryResult;
  };
  return { pool: { query } as unknown as pg.Pool, upserts };
}

const logs: unknown[] = [];
const ctxFor = (p: pg.Pool): JobContext =>
  ({
    platformPool: p,
    log: {
      info: (o: object) => logs.push(o),
      warn: (o: object) => logs.push(o),
      error: (o: object) => logs.push(o),
    },
  }) as unknown as JobContext;

const hosted = (calls: string[][]): EmbedProvider => ({
  descriptor: { ...fakeEmbedDescriptor, id: 'hosted-embed', retentionClass: 'zdr_contractual' },
  model: DEFAULT_EMBED_MODEL,
  dims: EMBED_DIMS,
  async embed(i) {
    calls.push(i.texts);
    return i.texts.map(() => [1, ...new Array<number>(EMBED_DIMS - 1).fill(0)]);
  },
});

describe('policy routing (NEG-8)', () => {
  const texts = new Map(hashes(3).map((h, i) => [h.toString('hex'), `text ${i}`]));

  it('control: a self-hosted provider embeds and upserts every hash under the pin', async () => {
    const calls: string[][] = [];
    const { pool: p, upserts } = pool(texts);
    const runtime: EmbedRuntime = {
      policy: { selfHostOnly: true, requireZdr: true },
      providers: [createFakeEmbed({ onCall: (t) => calls.push([...t]) })],
      batchSize: 2,
    };
    const out = await fillHashes(ctxFor(p), runtime, ORG, PIN, hashes(3));
    expect(out).toEqual({ status: 'embedded', written: 3, embedCalls: 2, texts: 3 });
    expect(upserts).toHaveLength(3);
    expect(upserts.every((u) => u.pin === PIN.id && u.vector.length === EMBED_DIMS)).toBe(true);
    expect(calls.flat()).toEqual(['text 0', 'text 1', 'text 2']);
  });

  it('under the default selfHostOnly a hosted provider is refused: zero embed calls, zero writes, no fallback', async () => {
    const calls: string[][] = [];
    const { pool: p, upserts } = pool(texts);
    const runtime: EmbedRuntime = {
      policy: { selfHostOnly: true, requireZdr: true },
      providers: [hosted(calls)],
    };
    const out = await fillHashes(ctxFor(p), runtime, ORG, PIN, hashes(3));
    expect(out).toEqual({ status: 'refused', reason: 'not_self_hosted' });
    expect(calls).toEqual([]);
    expect(upserts).toEqual([]);
  });

  it('a refused first provider never falls back to a second, self-hosted one of the same model', () => {
    const calls: string[][] = [];
    const picked = providerForPin(
      {
        policy: { selfHostOnly: true, requireZdr: false },
        providers: [hosted(calls), createFakeEmbed()],
      },
      PIN,
      { info: () => undefined, warn: () => undefined, error: () => undefined },
    );
    expect(picked).toEqual({ refused: 'not_self_hosted' });
  });

  it('a pin whose model has no configured provider is reported, not embedded with another model', async () => {
    const { pool: p, upserts } = pool(texts);
    const runtime: EmbedRuntime = {
      policy: { selfHostOnly: true, requireZdr: true },
      providers: [createFakeEmbed({ model: 'other-model' })],
    };
    expect(await fillHashes(ctxFor(p), runtime, ORG, PIN, hashes(1))).toEqual({
      status: 'no_provider',
    });
    expect(upserts).toEqual([]);
  });

  it('static scan: the worker has exactly one EmbedProvider.embed call site (embed.ts, after selectProvider)', () => {
    const root = new URL('..', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          p.endsWith('.ts') &&
          !/\.(test|integration)\.ts$/.test(p) &&
          !p.includes('/testing/')
        )
          files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    const sites = files.flatMap((f) =>
      (readFileSync(f, 'utf8').match(/\.embed\(/g) ?? []).map(() => f.slice(root.length)),
    );
    expect(sites).toEqual(['documents/embed.ts']);
    expect(readFileSync(join(root, 'documents/embed.ts'), 'utf8')).toContain(
      "selectProvider(runtime.policy, candidates.slice(0, 1), 'embed')",
    );
  });
});

describe('redaction (NEG-10)', () => {
  const CANARY = 'CANARY-CHUNK-TEXT-93113';
  it('a provider error that echoes its input becomes a fixed-code EmbedJobError', async () => {
    const texts = new Map([[hashes(1)[0]!.toString('hex'), CANARY]]);
    const echoing: EmbedProvider = {
      ...createFakeEmbed(),
      async embed(i) {
        throw new Error(`upstream said: cannot embed ${JSON.stringify(i.texts)}`);
      },
    };
    const { pool: p } = pool(texts);
    const err = await fillHashes(
      ctxFor(p),
      { policy: { selfHostOnly: true, requireZdr: true }, providers: [echoing] },
      ORG,
      PIN,
      hashes(1),
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(EmbedJobError);
    const e = err as EmbedJobError;
    expect(e.message).toBe('embed job failed: provider');
    expect(JSON.stringify({ m: e.message, s: e.stack, c: e.cause })).not.toContain(CANARY);
    expect(JSON.stringify(logs)).not.toContain(CANARY);
  });

  it('an EmbedError keeps only its code', async () => {
    const texts = new Map([[hashes(1)[0]!.toString('hex'), CANARY]]);
    const failing: EmbedProvider = {
      ...createFakeEmbed(),
      async embed() {
        throw new EmbedError('upstream', 500);
      },
    };
    const { pool: p } = pool(texts);
    const err = await fillHashes(
      ctxFor(p),
      { policy: { selfHostOnly: true, requireZdr: true }, providers: [failing] },
      ORG,
      PIN,
      hashes(1),
    ).catch((e: Error) => e);
    expect((err as EmbedJobError).message).toBe('embed job failed: upstream');
  });

  it('a provider returning the wrong number of vectors is refused', async () => {
    const texts = new Map(hashes(2).map((h) => [h.toString('hex'), 'x']));
    const short: EmbedProvider = { ...createFakeEmbed(), embed: async () => [] };
    const { pool: p, upserts } = pool(texts);
    await expect(
      fillHashes(
        ctxFor(p),
        { policy: { selfHostOnly: true, requireZdr: true }, providers: [short] },
        ORG,
        PIN,
        hashes(2),
      ),
    ).rejects.toThrow('embed job failed: provider_count');
    expect(upserts).toEqual([]);
  });
});
