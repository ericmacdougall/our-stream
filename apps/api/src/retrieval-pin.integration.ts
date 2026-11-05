// SPDX-License-Identifier: AGPL-3.0-only
// AC-3/AC-4: retrieval stays on the ACTIVE pin while a shadow pin fills, switches with it, writes the new pin
// id as a literal into the SQL text, and the EXPLAIN assertion (HNSW index scan) holds after the switch too.
// An embedder whose model is not the active pin's model is never used (keyword_only, pin_mismatch).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensurePinIndex, pinIndexName, reportPinReadiness, withTenant } from '@our-stream/db';
import { applyApproxSettings, buildApproxSql, DEFAULT_TUNING } from './lib/retrieval/engine.js';
import {
  addMember,
  createWorld,
  DEFAULT_PIN_ID,
  dbReady,
  embedOrg,
  engineInput,
  insertOrg,
  insertUser,
  PIN_MODEL,
  runEngineApp,
  seedContent,
  type World,
} from './retrieval-test-support.js';

// Chatty suites: a remote database (dev2 through a tunnel) multiplies round trips.
vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

describe.skipIf(!dbReady)('retrieval across an embedding pin switch', () => {
  let w: World;
  let org = '';
  let user = '';
  const chunkIds: string[] = [];

  beforeAll(async () => {
    w = await createWorld('rtpin');
    org = await insertOrg(w, `rtpin-${Date.now()}`, { documents_enabled: true });
    user = await insertUser(w, 'pinuser');
    const owner = await insertUser(w, 'pinowner');
    await addMember(w, org, user, 'member');
    await addMember(w, org, owner, 'owner');
    for (let d = 0; d < 6; d += 1) {
      const s = await seedContent(w, {
        orgId: org,
        kind: 'document',
        ownerId: owner,
        chunks: [`pinswitch doc ${d} first`, `pinswitch doc ${d} second`],
        audience: [{ subjectType: 'org', subjectId: org, subjectRelation: 'member' }],
      });
      chunkIds.push(...s.chunkIds);
    }
    await embedOrg(w, org);
  }, 120_000);

  afterAll(async () => {
    await w?.close();
  });

  const planFor = (pinId: string) =>
    withTenant(
      w.app,
      { orgId: org, userId: user },
      async (client) => {
        await applyApproxSettings(client, DEFAULT_TUNING);
        const a = buildApproxSql(engineInput(org, user, 'pinswitch'), pinId, 40);
        expect(a.text).toContain(`'${pinId}'::uuid`);
        const r = await client.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (FORMAT JSON, COSTS OFF) ${a.text}`,
          a.values,
        );
        return JSON.stringify(r.rows[0]!['QUERY PLAN']);
      },
      { isolation: 'REPEATABLE READ' },
    );

  it('active pin first, shadow pin fills without changing retrieval, then the switch moves retrieval and its index', async () => {
    const before = await runEngineApp(w, engineInput(org, user, 'pinswitch', { k: 50 }));
    expect(before.pinId).toBe(DEFAULT_PIN_ID);
    expect(before.retrievalMode).toBe('hybrid');
    expect(new Set(before.items.map((i) => i.chunkId))).toEqual(new Set(chunkIds));
    expect(await planFor(DEFAULT_PIN_ID)).toContain(pinIndexName(DEFAULT_PIN_ID));

    const reg = await w.platform.query<{ id: string }>(
      `SELECT platform_embedding_pin_register('shadow-fake-model', 1024) AS id`,
    );
    const shadow = reg.rows[0]!.id;
    const idx = await ensurePinIndex(w.adminUrl, shadow);
    expect(idx.valid).toBe(true);
    expect(await embedOrg(w, org, shadow)).toBeGreaterThan(0);
    const ready = await reportPinReadiness(w.platformUrl, shadow, idx.valid);
    expect(ready.coverageComplete).toBe(true);

    // still on the active pin while the shadow is ready but not switched
    const still = await runEngineApp(w, engineInput(org, user, 'pinswitch', { k: 50 }));
    expect(still.pinId).toBe(DEFAULT_PIN_ID);
    expect(still.retrievalMode).toBe('hybrid');
    const wrongModel = await runEngineApp(
      w,
      engineInput(org, user, 'pinswitch', { k: 50, embedderModel: 'shadow-fake-model' }),
    );
    expect(wrongModel.retrievalMode).toBe('keyword_only');
    expect(wrongModel.degraded).toBe('pin_mismatch');

    await w.platform.query('SELECT platform_embedding_pin_switch($1)', [shadow]);

    const after = await runEngineApp(
      w,
      engineInput(org, user, 'pinswitch', { k: 50, embedderModel: 'shadow-fake-model' }),
    );
    expect(after.pinId).toBe(shadow);
    expect(after.retrievalMode).toBe('hybrid');
    expect(new Set(after.items.map((i) => i.chunkId))).toEqual(new Set(chunkIds));
    const old = await runEngineApp(
      w,
      engineInput(org, user, 'pinswitch', { k: 50, embedderModel: PIN_MODEL }),
    );
    expect(old.retrievalMode).toBe('keyword_only'); // the previous model is no longer the pin's model
    expect(old.degraded).toBe('pin_mismatch');

    const plan = await planFor(shadow);
    expect(plan).toContain(pinIndexName(shadow));
    expect(plan).not.toContain(pinIndexName(DEFAULT_PIN_ID));
  }, 120_000);
});
