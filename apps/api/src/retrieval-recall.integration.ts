// SPDX-License-Identifier: AGPL-3.0-only
// NEG-4 and AC-4 (approximate mode): 20,000 chunks over 3 orgs, the asker may see 1 percent. recall@10 against
// an independent exact ranking (computed in the test from the stored texts) is at least 0.95, no unpermitted
// chunk fills k, and the exact-scan fallback is what saves recall when the approximate leg runs short (broken
// variant: fallback disabled, which MUST fail the same assertion). Settings under test: hnsw.ef_search,
// hnsw.iterative_scan = relaxed_order and hnsw.max_scan_tuples from lib/retrieval/constants.ts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensurePinIndex, withTenant } from '@our-stream/db';
import {
  applyApproxSettings,
  buildApproxSql,
  DEFAULT_TUNING,
  type EngineVariant,
  type Tuning,
} from './lib/retrieval/engine.js';
import {
  addMember,
  createWorld,
  DEFAULT_PIN_ID,
  dbReady,
  embedOrg,
  engineInput,
  insertOrg,
  insertUser,
  runEngineApp,
  seedContent,
  vectorFor,
  type World,
} from './retrieval-test-support.js';

// Chatty suites: a remote database (dev2 through a tunnel) multiplies round trips.
vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const DOCS_PER_ORG = [67, 67, 66];
const CHUNKS_PER_DOC = 100;
const K = 10;
const QUERIES = 30;

const cosine = (a: number[], b: number[]) => {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += a[i]! * b[i]!;
  return d; // both unit vectors
};

describe.skipIf(!dbReady)('NEG-4: recall over 20,000 chunks, 3 orgs, asker sees 1 percent', () => {
  let w: World;
  let org1 = '';
  let asker = '';
  const permitted = new Map<string, string>(); // chunk id -> text
  let totalChunks = 0;

  beforeAll(async () => {
    w = await createWorld('rtrecall');
    // Bulk load without the index (rebuilt below with the real post-migrate job), vectors still go through
    // platform_embedding_upsert.
    await w.admin.query('DROP INDEX embedding_hnsw_5a7e0001');
    asker = await insertUser(w, 'asker');
    const owner = await insertUser(w, 'recallowner');
    const orgs: string[] = [];
    for (let o = 0; o < 3; o += 1) {
      const id = await insertOrg(w, `rtrecall-${o}-${randomUUID().slice(0, 6)}`, {
        documents_enabled: true,
      });
      orgs.push(id);
      await addMember(w, id, owner, 'owner');
      await addMember(w, id, asker, 'member');
    }
    org1 = orgs[0]!;
    for (let o = 0; o < 3; o += 1) {
      for (let d = 0; d < DOCS_PER_ORG[o]!; d += 1) {
        // In org 1 the asker may see exactly docs 0 and 1 (200 chunks = 1% of 20,000); everything else is
        // addressed to the owner only. Orgs 2 and 3 grant the asker nothing.
        const visibleToAsker = o === 0 && d < 2;
        const s = await seedContent(w, {
          orgId: orgs[o]!,
          kind: 'document',
          ownerId: owner,
          chunks: Array.from(
            { length: CHUNKS_PER_DOC },
            (_, i) => `corpus o${o} d${d} c${i} ${randomUUID()}`,
          ),
          audience: [
            visibleToAsker
              ? { subjectType: 'org', subjectId: orgs[o]!, subjectRelation: 'member' }
              : { subjectType: 'user', subjectId: owner, subjectRelation: '' },
          ],
        });
        totalChunks += s.chunkIds.length;
        if (visibleToAsker) {
          const texts = await w.admin.query<{ id: string; text: string }>(
            'SELECT id, text FROM chunk WHERE org_id = $1 AND content_id = $2',
            [orgs[o], s.contentId],
          );
          for (const r of texts.rows) permitted.set(r.id, r.text);
        }
      }
      await embedOrg(w, orgs[o]!);
    }
    const report = await ensurePinIndex(w.adminUrl, DEFAULT_PIN_ID);
    expect(report.valid).toBe(true);
    await w.admin.query('ANALYZE');
  }, 900_000);

  afterAll(async () => {
    await w?.close();
  });

  const queryVectors = Array.from({ length: QUERIES }, (_, i) => vectorFor(`recall probe ${i}`));
  const exactTopK = (qv: number[]): string[] =>
    [...permitted.entries()]
      .map(([id, text]) => ({ id, sim: cosine(qv, vectorFor(text)) }))
      .sort((a, b) => b.sim - a.sim || (a.id < b.id ? -1 : 1))
      .slice(0, K)
      .map((x) => x.id);

  /** Mean recall@10 of the engine against the independent exact ranking; asserts nothing unpermitted appears. */
  async function meanRecall(
    tuning: Partial<Tuning>,
    variant?: EngineVariant,
  ): Promise<{ recall: number; fallbacks: number }> {
    let hit = 0;
    let fallbacks = 0;
    for (let i = 0; i < QUERIES; i += 1) {
      const qv = queryVectors[i]!;
      const r = await runEngineApp(
        w,
        engineInput(org1, asker, `zzqq${i}`, {
          k: K,
          queryVector: qv,
          tuning,
          ...(variant ? { variant } : {}),
        }),
      );
      const got = r.items.map((x) => x.chunkId);
      for (const id of got)
        expect(permitted.has(id), `query ${i}: unpermitted chunk ${id}`).toBe(true);
      expect(got.length, `query ${i} must fill k with permitted chunks`).toBe(K);
      if (r.fallbackUsed) fallbacks += 1;
      const exact = new Set(exactTopK(qv));
      hit += got.filter((id) => exact.has(id)).length;
    }
    return { recall: hit / (QUERIES * K), fallbacks };
  }

  it('the corpus is as specified: 20,000 chunks over 3 orgs, the asker may see exactly 1 percent', async () => {
    expect(totalChunks).toBe(20_000);
    expect(permitted.size).toBe(200);
    const embedded = await w.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM embedding');
    expect(embedded.rows[0]!.n).toBe(20_000);
  });

  it('approximate mode with the fixed settings: recall@10 >= 0.95 and the HNSW index is used', async () => {
    const { recall, fallbacks } = await meanRecall({});
    console.log(
      `NEG-4 default settings (ef_search=${DEFAULT_TUNING.efSearch}, max_scan_tuples=${DEFAULT_TUNING.maxScanTuples}, relaxed_order): recall@10=${recall.toFixed(4)} fallbacks=${fallbacks}/${QUERIES}`,
    );
    expect(recall).toBeGreaterThanOrEqual(0.95);
    const plan = await withTenant(
      w.app,
      { orgId: org1, userId: asker },
      async (client) => {
        await applyApproxSettings(client, DEFAULT_TUNING);
        const a = buildApproxSql(
          engineInput(org1, asker, 'x', { queryVector: queryVectors[0]! }),
          DEFAULT_PIN_ID,
          K * 4,
        );
        const r = await client.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (FORMAT JSON, COSTS OFF) ${a.text}`,
          a.values,
        );
        return JSON.stringify(r.rows[0]!['QUERY PLAN']);
      },
      { isolation: 'REPEATABLE READ' },
    );
    expect(plan).toContain('embedding_hnsw_5a7e0001');
  });

  describe('when the approximate leg runs short (max_scan_tuples = 200 reaches ~1 permitted row of 100)', () => {
    const short: Partial<Tuning> = { maxScanTuples: 200 };

    it('the exact-scan fallback restores recall >= 0.95 and fills k', async () => {
      const { recall, fallbacks } = await meanRecall(short);
      console.log(
        `NEG-4 short scan with fallback: recall@10=${recall.toFixed(4)} fallbacks=${fallbacks}/${QUERIES}`,
      );
      expect(fallbacks).toBeGreaterThan(0);
      expect(recall).toBeGreaterThanOrEqual(0.95);
    });

    it('broken variant: with the fallback disabled the same assertion FAILS (recall collapses or k is not filled)', async () => {
      await expect(meanRecall(short, 'no_fallback')).rejects.toThrow(/must fill k/);
    });

    it('broken variant: with the HNSW index disabled the EXPLAIN assertion FAILS', async () => {
      const plan = await withTenant(
        w.app,
        { orgId: org1, userId: asker },
        async (client) => {
          await applyApproxSettings(client, DEFAULT_TUNING, 'no_index');
          const a = buildApproxSql(
            engineInput(org1, asker, 'x', { queryVector: queryVectors[0]! }),
            DEFAULT_PIN_ID,
            K * 4,
          );
          const r = await client.query<{ 'QUERY PLAN': unknown }>(
            `EXPLAIN (FORMAT JSON, COSTS OFF) ${a.text}`,
            a.values,
          );
          return JSON.stringify(r.rows[0]!['QUERY PLAN']);
        },
        { isolation: 'REPEATABLE READ' },
      );
      expect(plan).not.toContain('embedding_hnsw_5a7e0001');
    });
  });
});
