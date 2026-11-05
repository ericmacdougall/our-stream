// SPDX-License-Identifier: AGPL-3.0-only
// M2a retrieval (AC-4, NEG-3, NEG-7, NEG-8, flag matrix): permission-filtered keyword + vector retrieval over
// the authz fixture matrix. Exact mode equals the reference implementation per role; broken variants (wrong
// predicate, returns nothing, post-check disabled with a leaking predicate, index disabled) MUST be detected
// by the same assertions. Vectors are seeded through platform_embedding_upsert, chunks are direct inserts that
// the core trigger hashes. Runs in its own scratch database (deployment-global state is toggled).
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildFixture, NOW, readerVisible, USER_NAMES, type FixtureOrg } from '@our-stream/authz';
import { withTenant } from '@our-stream/db';
import { FixedWindowLimiter } from './lib/limits.js';
import {
  applyApproxSettings,
  buildApproxSql,
  retrieve,
  DEFAULT_TUNING,
  type EngineVariant,
} from './lib/retrieval/engine.js';
import { readCounter, LEAK_CHECK_FAILED } from './lib/retrieval/metrics.js';
import { referencePostCheck } from './lib/retrieval/reference-check.js';
import {
  addMember,
  buildRetrievalApp,
  createWorld,
  dbReady,
  embedOrg,
  engineInput,
  FakeEmbedder,
  insertGroup,
  insertOrg,
  insertStream,
  insertTuples,
  insertUser,
  query,
  runEngineAdmin,
  runEngineApp,
  seededRandom,
  seedContent,
  sessionFor,
  DEFAULT_PIN_ID,
  type World,
} from './retrieval-test-support.js';

// Chatty suites: a remote database (dev2 through a tunnel) multiplies round trips.
vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const FIXED_NOW = NOW;

describe.skipIf(!dbReady)('retrieval over the authz fixture matrix', () => {
  let w: World;
  const fixture = buildFixture('-rt', { documents: true });
  const chunksOf = new Map<string, string[]>(); // content id -> chunk ids
  const tokens = new Map<string, string>(); // `${org.slug}:${userName}` -> bearer token
  const embedder = new FakeEmbedder();
  let app: FastifyInstance;

  /** Chunks the reference implementation says a user may retrieve (current version, readerVisible at NOW). */
  function expectedChunks(org: FixtureOrg, userId: string): Set<string> {
    const out = new Set<string>();
    for (const c of org.content) {
      if (c.currentVersionStatus !== 'current') continue; // chunks of a non-current version are never served
      if (!readerVisible(org, userId, c.id, FIXED_NOW)) continue;
      for (const id of chunksOf.get(c.id) ?? []) out.add(id);
    }
    return out;
  }

  beforeAll(async () => {
    w = await createWorld('rtfx');
    for (const [name, id] of Object.entries(fixture.users)) await insertUser(w, name, id);
    for (const org of fixture.orgs) {
      await insertOrg(w, org.slug, { documents_enabled: org.documentsEnabled }, org.orgId);
      for (const m of org.memberships) await addMember(w, org.orgId, m.userId, m.role, m.status);
      for (const g of org.groups) await insertGroup(w, org.orgId, g.id);
      for (const [name, id] of Object.entries(org.streamNames))
        await insertStream(w, org.orgId, id, name);
      for (const c of org.content) {
        const seeded = await seedContent(w, {
          orgId: org.orgId,
          id: c.id,
          kind: c.kind,
          ownerId: c.ownerId,
          state: c.state,
          publishAt: c.publishAt,
          expiresAt: c.expiresAt,
          retractedAt: c.retractedAt,
          reviewRequested: c.reviewRequested,
          versionStatus: c.currentVersionStatus,
          chunks: [0, 1].map(
            (i) => `${org.slug} onboarding policy chunk ${i} for ${c.id.slice(0, 8)}`,
          ),
        });
        chunksOf.set(c.id, seeded.chunkIds);
      }
      await insertTuples(w, org.orgId, org.tuples);
      await embedOrg(w, org.orgId);
      for (const [name, id] of Object.entries(fixture.users))
        tokens.set(`${org.slug}:${name}`, await sessionFor(w, id, org.orgId));
    }
    await w.admin.query('ANALYZE');
    app = await buildRetrievalApp(w, {
      embedder,
      now: () => FIXED_NOW,
      limiter: new FixedWindowLimiter({ max: 100_000, windowMs: 60_000 }),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await w?.close();
  });

  const idsOf = (r: Awaited<ReturnType<typeof query>>) =>
    new Set((r.body.items ?? []).map((i) => i.chunkId));
  const same = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((x) => b.has(x));

  /** The exact-mode assertion: every (org, user) cell equals the reference set, with non-zero expectations for permitted roles. */
  async function assertExactEqualsReference(
    runOne: (org: FixtureOrg, userName: string, userId: string) => Promise<Set<string>>,
  ): Promise<number> {
    let nonZeroCells = 0;
    for (const org of fixture.orgs) {
      for (const name of USER_NAMES) {
        const userId = fixture.users[name]!;
        const member = org.memberships.find((m) => m.userId === userId && m.status === 'active');
        const expected = expectedChunks(org, userId);
        if (
          member &&
          ['owner', 'admin', 'member', 'member2'].includes(name) &&
          org.documentsEnabled
        )
          expect(expected.size, `${org.slug}:${name} must have permitted chunks`).toBeGreaterThan(
            0,
          );
        const got = await runOne(org, name, userId);
        expect(
          [...got].sort(),
          `${org.slug}:${name} exact set (got ${got.size}, expected ${expected.size})`,
        ).toEqual([...expected].sort());
        if (expected.size > 0) nonZeroCells += 1;
      }
    }
    return nonZeroCells;
  }

  const viaApi =
    (vApp: FastifyInstance) =>
    async (org: FixtureOrg, name: string): Promise<Set<string>> => {
      const r = await query(vApp, tokens.get(`${org.slug}:${name}`)!, 'onboarding policy', 50);
      if (r.status === 403) return new Set(); // deactivated member: refused before any query
      expect(r.status, r.raw).toBe(200);
      return idsOf(r);
    };

  it('exact mode (k above the permitted count) equals the reference set for every fixture role, RLS on', async () => {
    const cells = await assertExactEqualsReference(viaApi(app));
    expect(cells).toBeGreaterThan(10);
  });

  it('exact mode equals the reference set with RLS bypassed (superuser connection) too', async () => {
    const cells = await assertExactEqualsReference(async (org, _n, userId) => {
      const r = await runEngineAdmin(
        w,
        engineInput(org.orgId, userId, 'onboarding policy', { k: 50, now: FIXED_NOW }),
      );
      return new Set(r.items.map((i) => i.chunkId));
    });
    expect(cells).toBeGreaterThan(10);
  });

  it('seeded property test: results are a subset of the reference set, of size min(k, permitted), RLS on and off', async () => {
    const seed = Number(process.env['RETRIEVAL_SEED'] ?? 20261104);
    console.log(`retrieval property test seed=${seed}`);
    const rand = seededRandom(seed);
    const vocab = [
      'onboarding policy',
      'policy',
      'chunk',
      'zzz nothing matches',
      'onboarding',
      'café policy',
      'chunk 1',
    ];
    let nonZero = 0;
    for (let i = 0; i < 80; i += 1) {
      const org = fixture.orgs[Math.floor(rand() * 2)]!;
      const name = USER_NAMES[Math.floor(rand() * USER_NAMES.length)]!;
      const userId = fixture.users[name]!;
      const q = vocab[Math.floor(rand() * vocab.length)]!;
      const k = 1 + Math.floor(rand() * 50);
      const expected = expectedChunks(org, userId);
      const input = engineInput(org.orgId, userId, q, { k, now: FIXED_NOW });
      const rls = i % 2 === 0;
      const r = rls ? await runEngineApp(w, input) : await runEngineAdmin(w, input);
      const got = r.items.map((x) => x.chunkId);
      const ctx = `seed=${seed} i=${i} rls=${rls} org=${org.slug} user=${name} q=${q} k=${k}`;
      const active = org.memberships.some((m) => m.userId === userId && m.status === 'active');
      if (!active) {
        expect(got, ctx).toEqual([]);
        continue;
      }
      for (const id of got) expect(expected.has(id), `${ctx} leaked ${id}`).toBe(true);
      expect(got.length, ctx).toBe(Math.min(k, expected.size));
      if (k >= expected.size) expect(same(new Set(got), expected), ctx).toBe(true);
      if (expected.size > 0) nonZero += 1;
    }
    expect(nonZero).toBeGreaterThan(30);
  });

  it('post-check cost at k up to 20 (owner-chosen budget: p95 at most 20 ms on dev2; measured and printed, not asserted)', async () => {
    const org = fixture.orgs[0]!;
    // the fixture user with the most permitted chunks
    const userId = USER_NAMES.map((n) => fixture.users[n]!).sort(
      (a, b) => expectedChunks(org, b).size - expectedChunks(org, a).size,
    )[0]!;
    const want = Math.min(20, expectedChunks(org, userId).size);
    expect(want).toBeGreaterThan(5);
    const times: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      await withTenant(
        w.app,
        { orgId: org.orgId, userId },
        async (client) => {
          const r = await retrieve(
            client,
            engineInput(org.orgId, userId, 'onboarding policy', { k: 20, now: FIXED_NOW }),
          );
          expect(r.items.length).toBe(want);
          const t0 = performance.now();
          await referencePostCheck(
            client,
            org.orgId,
            userId,
            FIXED_NOW,
            r.items.map((x) => ({
              chunkId: x.chunkId,
              contentId: x.contentId,
              versionId: x.versionId,
            })),
          );
          times.push(performance.now() - t0);
        },
        { isolation: 'REPEATABLE READ' },
      );
    }
    times.sort((a, b) => a - b);
    console.log(
      `post-check k=${want} over ${times.length} runs: p50=${times[20]!.toFixed(1)}ms p95=${times[37]!.toFixed(1)}ms`,
    );
    expect(times.length).toBe(40);
  });

  describe('broken variants must be detected by the same assertions', () => {
    const variants: EngineVariant[] = ['wrong_predicate', 'returns_nothing'];
    for (const variant of variants) {
      it(`${variant}: the exact-equality assertion fails`, async () => {
        const broken = await buildRetrievalApp(w, {
          embedder,
          now: () => FIXED_NOW,
          variant,
          limiter: new FixedWindowLimiter({ max: 100_000, windowMs: 60_000 }),
        });
        try {
          await expect(assertExactEqualsReference(viaApi(broken))).rejects.toThrow();
        } finally {
          await broken.close();
        }
      });
    }

    it('leak_without_post_check (leaking predicate, post-check disabled): the exact-equality assertion fails', async () => {
      const broken = await buildRetrievalApp(w, {
        embedder,
        now: () => FIXED_NOW,
        variant: 'leak_without_post_check',
        limiter: new FixedWindowLimiter({ max: 100_000, windowMs: 60_000 }),
      });
      try {
        await expect(assertExactEqualsReference(viaApi(broken))).rejects.toThrow(
          /exact set|leak|expected/,
        );
      } finally {
        await broken.close();
      }
    });

    it('a leaking predicate WITH the post-check fails closed: HTTP 500, no items, counter incremented', async () => {
      const broken = await buildRetrievalApp(w, {
        embedder,
        now: () => FIXED_NOW,
        variant: 'wrong_predicate',
        limiter: new FixedWindowLimiter({ max: 100_000, windowMs: 60_000 }),
      });
      try {
        const org = fixture.orgs[0]!;
        const before = readCounter(LEAK_CHECK_FAILED);
        const r = await query(broken, tokens.get(`${org.slug}:member`)!, 'onboarding policy', 50);
        expect(r.status).toBe(500);
        expect(r.body.items).toBeUndefined();
        expect(r.body.error?.code).toBe('internal');
        expect(readCounter(LEAK_CHECK_FAILED)).toBe(before + 1);
      } finally {
        await broken.close();
      }
    });
  });

  it('approximate leg: EXPLAIN shows the HNSW index scan with the pin id as a literal; index disabled is detected', async () => {
    const org = fixture.orgs[0]!;
    const userId = fixture.users.member!;
    const explain = async (variant?: EngineVariant) =>
      withTenant(
        w.app,
        { orgId: org.orgId, userId },
        async (client) => {
          await applyApproxSettings(client, DEFAULT_TUNING, variant);
          const input = engineInput(org.orgId, userId, 'onboarding policy', { now: FIXED_NOW });
          const a = buildApproxSql(input, DEFAULT_PIN_ID, 40);
          expect(a.text).toContain(`'${DEFAULT_PIN_ID}'::uuid`); // literal, never a bind parameter
          expect(a.values).not.toContain(DEFAULT_PIN_ID);
          const r = await client.query<{ 'QUERY PLAN': unknown }>(
            `EXPLAIN (FORMAT JSON, COSTS OFF) ${a.text}`,
            a.values,
          );
          return JSON.stringify(r.rows[0]!['QUERY PLAN']);
        },
        { isolation: 'REPEATABLE READ' },
      );
    const plan = await explain();
    expect(plan).toContain('"Index Name":"embedding_hnsw_5a7e0001"');
    const broken = await explain('no_index');
    expect(broken).not.toContain('embedding_hnsw_5a7e0001'); // the assertion above would fail on this plan
  });
});
