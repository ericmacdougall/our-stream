// SPDX-License-Identifier: AGPL-3.0-only
// M2a worker pipeline against a real database (scratch database per run: pins and flags are global state):
// routing, attest/claim/parse/finish, fencing, kill after claim, attestation exhaustion, embedding with
// zero-call reruns, reconciliation and garbage collection, clip backfill with the flag, the shadow pin flow,
// canary redaction and the SQL/TypeScript hash cross-check.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePinIndex, runMigrations } from '@our-stream/db';
import { ParserClient, textSha256, type Block } from '@our-stream/documents';
import { SandboxSim } from '@our-stream/documents/testing';
import { createFakeEmbed, DEFAULT_EMBED_MODEL, type EmbedProvider } from '@our-stream/providers';
import type { JobContext } from './jobs.js';
import { documentProcess, DocumentJob } from './documents/process.js';
import { activePin, embedVersion, reconcileOnce, type EmbedRuntime } from './documents/embed.js';
import { fillPin, markReady, switchPin } from './documents/pin.js';
import { drainOnce } from './outbox.js';
import { createScratchDatabase, makeDb, type Db, type Org, type Scratch } from './testing/db.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const appUrl = process.env['DATABASE_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL'];
const enabled = Boolean(adminUrl && appUrl && platformUrl);

describe.skipIf(!enabled)('worker documents (integration)', () => {
  let scratch: Scratch;
  let db: Db;
  let work: string;
  let sim: SandboxSim;
  let blocks: Block[] = [{ text: 'default text', locator: {} }];
  let embedCalls: string[][] = [];
  let logs: unknown[] = [];
  let sends: { name: string; data: unknown }[] = [];
  const provider = (model = DEFAULT_EMBED_MODEL) =>
    createFakeEmbed({ model, onCall: (t) => embedCalls.push([...t]) });
  let runtimeProviders: EmbedProvider[] = [];

  const ctx = (over: Partial<JobContext> = {}): JobContext =>
    ({
      tenantPool: db.app,
      platformPool: db.platform,
      queue: {
        send: async (name: string, data: object) => {
          sends.push({ name, data });
          return 'id';
        },
      },
      store: {
        download: async (_k: string, dest: string) => {
          await writeFile(dest, 'original bytes');
          return { size: 14 };
        },
      },
      limits: { tmpRoot: work },
      parser: new ParserClient({
        slotDir: join(work, 'slot'),
        ctlDir: join(work, 'ctl'),
        pollMs: 10,
        challengeTimeoutMs: 600,
        resultGraceMs: 500,
      }),
      embed: {
        policy: { selfHostOnly: true, requireZdr: true },
        providers: runtimeProviders,
        batchSize: 4,
      } satisfies EmbedRuntime,
      log: {
        info: (o: object, m?: string) => logs.push({ o, m }),
        warn: (o: object, m?: string) => logs.push({ o, m }),
        error: (o: object, m?: string) => logs.push({ o, m }),
      },
      now: () => new Date(),
      ...over,
    }) as unknown as JobContext;

  beforeAll(async () => {
    scratch = await createScratchDatabase(adminUrl!, appUrl!, platformUrl!, 'worker_docs');
    await runMigrations(scratch.adminUrl);
    db = await makeDb(scratch.adminUrl, scratch.appUrl, scratch.platformUrl);
    work = await mkdtemp(join(tmpdir(), 'worker-docs-'));
    sim = new SandboxSim({
      slotDir: join(work, 'slot'),
      ctlDir: join(work, 'ctl'),
      behaviour: () => ({ kind: 'blocks', blocks }),
    });
    await sim.start();
    runtimeProviders = [provider()];
  });
  afterAll(async () => {
    sim?.stop();
    await db?.close();
    await scratch?.drop();
  });

  /** init + complete + upload event, as the API route leaves it. */
  async function upload(org: Org, content: string, mime?: string) {
    const v = await db.initVersion(org, content, mime);
    await db.complete(org, content, v);
    await db.q(
      `INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload) VALUES ($1, 'content.version_uploaded', 'content', $2, $3, '{}')`,
      [org.orgId, content, v],
    );
    return v;
  }
  const jobFor = (org: Org, content: string, version: string) =>
    DocumentJob.parse({ orgId: org.orgId, contentId: content, versionId: version });
  const reset = () => {
    embedCalls = [];
    logs = [];
    sends = [];
  };

  it('routes by kind, then runs attest -> claim -> parse -> finish and announces exactly once', async () => {
    reset();
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    const clip = await db.createContent(org, 'clip');
    await db.publish(org, doc);
    const v = await upload(org, doc);
    await db.q(
      `INSERT INTO content_version (org_id, content_id, status, original_key, mime_type) VALUES ($1, $2, 'uploaded', 'k', 'video/mp4')`,
      [org.orgId, clip],
    );
    const cv = (
      await db.q<{ id: string }>('SELECT id FROM content_version WHERE content_id = $1', [clip])
    )[0]!.id;
    await db.q(
      `INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload) VALUES ($1, 'content.version_uploaded', 'content', $2, $3, '{}')`,
      [org.orgId, clip, cv],
    );
    const c = ctx();
    await drainOnce(c);
    const mine = sends.filter((s) => JSON.stringify(s.data).includes(org.orgId));
    expect(mine.map((s) => s.name).sort()).toEqual(['document.process', 'media.process']);
    expect(mine.find((s) => s.name === 'document.process')?.data).toEqual({
      orgId: org.orgId,
      contentId: doc,
      versionId: v,
    });
    expect(mine.find((s) => s.name === 'media.process')?.data).toMatchObject({ contentId: clip });

    blocks = [
      { text: 'Onboarding', locator: { page: 1 }, heading: true, level: 1 },
      { text: 'New hires get a laptop on day one.', locator: { page: 1 } },
      { text: 'Second page about benefits.', locator: { page: 2 } },
    ];
    sends = [];
    await documentProcess(jobFor(org, doc, v), c);
    const row = await db.version(org, v);
    expect(row).toMatchObject({
      status: 'current',
      processing_step: 'done',
      processing_error: null,
      parse_attempt: null,
    });
    expect((await db.chunkTexts(org, v)).length).toBeGreaterThan(0);
    expect((await db.chunkTexts(org, v)).join('|')).toContain('laptop');
    const published = await db.q(
      'SELECT 1 FROM platform.domain_event WHERE org_id = $1 AND type = $2 AND version_id = $3',
      [org.orgId, 'content.published', v],
    );
    expect(published).toHaveLength(1);
    expect(sends.map((s) => s.name)).toEqual(['embed.version']);
    expect(sim.jobs.at(-1)?.slotFiles.sort()).toEqual(['input.bin', 'job.json']);
  });

  it('embeds once, makes zero embed calls for unchanged text on a replacement, and N for changed text (AC-3)', async () => {
    reset();
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    blocks = Array.from({ length: 5 }, (_, i) => ({
      text: `Paragraph ${i} of the handbook with words`,
      locator: { page: i + 1 },
    }));
    const c = ctx();
    const v1 = await upload(org, doc);
    await documentProcess(jobFor(org, doc, v1), c);
    await embedVersion({ orgId: org.orgId, versionId: v1 }, c);
    const first = embedCalls.flat().length;
    expect(first).toBe(5);
    expect(await db.embeddingCount(org)).toBe(5);

    // Replacement with identical text: nothing to embed, no vector lost.
    embedCalls = [];
    const v2 = await upload(org, doc);
    await documentProcess(jobFor(org, doc, v2), c);
    expect((await db.version(org, v2)).status).toBe('current');
    await embedVersion({ orgId: org.orgId, versionId: v2 }, c);
    expect(embedCalls).toEqual([]);
    expect(await db.embeddingCount(org)).toBe(5);

    // One paragraph changed: exactly that text is embedded.
    blocks = blocks.map((b, i) =>
      i === 2 ? { ...b, text: 'A completely rewritten paragraph' } : b,
    );
    const v3 = await upload(org, doc);
    await documentProcess(jobFor(org, doc, v3), c);
    await embedVersion({ orgId: org.orgId, versionId: v3 }, c);
    expect(embedCalls.flat()).toEqual(['A completely rewritten paragraph']);
    expect(await db.embeddingCount(org)).toBe(6);
    // Broken-variant guard: the counter really sees calls (a hosted-style spy would too).
    expect(first).toBeGreaterThan(0);
  });

  it('kill after claim: the retried job completes and the dead attempt is fenced', async () => {
    reset();
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    const v = await upload(org, doc);
    blocks = [{ text: 'Recovered after a crash', locator: {} }];
    const dying = ctx({
      parser: {
        attest: async () => ({ nonce: 'n' }),
        run: async () => Promise.reject(new Error('worker killed')),
      } as unknown as ParserClient,
    });
    await expect(documentProcess(jobFor(org, doc, v), dying)).rejects.toThrow('worker killed');
    const mid = await db.version(org, v);
    expect(mid.status).toBe('processing');
    const deadAttempt = mid.parse_attempt;
    expect(deadAttempt).toMatch(/^[0-9a-f-]{36}$/);

    await documentProcess(jobFor(org, doc, v), ctx());
    expect((await db.version(org, v)).status).toBe('current');
    // The first attempt, arriving late, is stale and writes nothing.
    const late = await db.platform.query(
      'SELECT platform_document_finish($1, $2, $3, $4::jsonb) AS r',
      [org.orgId, v, deadAttempt, JSON.stringify([{ locator: {}, text: 'late', lang: 'en' }])],
    );
    expect(late.rows[0].r).toBe('stale');
    expect(await db.chunkTexts(org, v)).toEqual(['Recovered after a crash']);
  });

  it('attestation unavailable through all retries ends the version failed; before that it is untouched', async () => {
    reset();
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    const v = await upload(org, doc);
    const dead = new SandboxSim({
      slotDir: join(work, 'dead-slot'),
      ctlDir: join(work, 'dead-ctl'),
      heartbeat: false,
    });
    await dead.start();
    const c = ctx({
      parser: new ParserClient({
        slotDir: join(work, 'dead-slot'),
        ctlDir: join(work, 'dead-ctl'),
        pollMs: 10,
      }),
    });
    for (const retryCount of [0, 1, 2]) {
      await expect(
        documentProcess(jobFor(org, doc, v), c, { retryCount, retryLimit: 3 }),
      ).rejects.toThrow(/parser unavailable/);
      expect(await db.version(org, v), `retry ${retryCount}`).toMatchObject({
        status: 'uploaded',
        parse_attempt: null,
      });
    }
    await expect(
      documentProcess(jobFor(org, doc, v), c, { retryCount: 3, retryLimit: 3 }),
    ).rejects.toThrow(/parser unavailable/);
    expect(await db.version(org, v)).toMatchObject({
      status: 'failed',
      processing_error: 'parse_failed:parser_unavailable',
      parse_attempt: null,
    });
    dead.stop();
  });

  it('a refused claim (already current) is acknowledged without re-parsing', async () => {
    reset();
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    blocks = [{ text: 'once only', locator: {} }];
    const v = await upload(org, doc);
    await documentProcess(jobFor(org, doc, v), ctx());
    const jobsBefore = sim.jobs.length;
    await documentProcess(jobFor(org, doc, v), ctx());
    expect(sim.jobs.length).toBe(jobsBefore);
  });

  it('NEG-10: chunk text canaries appear in no log line, job payload or error', async () => {
    reset();
    const CANARY = 'CANARY-NEG10-5521-ZEBRA';
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    blocks = [{ text: `Confidential ${CANARY} paragraph`, locator: { page: 1 } }];
    const echoing: EmbedProvider = {
      ...createFakeEmbed(),
      async embed(i) {
        throw new Error(`upstream echo: ${JSON.stringify(i.texts)}`);
      },
    };
    const c = ctx({
      embed: { policy: { selfHostOnly: true, requireZdr: true }, providers: [echoing] },
    });
    const v = await upload(org, doc);
    await documentProcess(jobFor(org, doc, v), c);
    const err = await embedVersion({ orgId: org.orgId, versionId: v }, c).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((await db.chunkTexts(org, v)).join('\n')).toContain(CANARY); // control: the canary is really in the chunk
    const everything = JSON.stringify({
      logs,
      sends,
      err: [(err as Error).message, (err as Error).stack],
    });
    expect(everything).not.toContain(CANARY);
    expect(everything).toContain('embed job failed: provider');
  });

  it('SQL and TypeScript hash agree for new code points, decomposed text and repaired surrogates (NEG-1)', async () => {
    reset();
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    blocks = [
      { text: 'café shaking face \u{1FAE8} and \u{1FAE9} and é', locator: { page: 1 } },
      { text: 'lone \ud800 surrogate', locator: { page: 2 } },
      { text: 'Å angstrom and Å composed', locator: { page: 3 } },
    ];
    const v = await upload(org, doc);
    await documentProcess(jobFor(org, doc, v), ctx());
    const rows = await db.q<{ text: string; hex: string }>(
      `SELECT text, encode(text_sha256, 'hex') AS hex FROM chunk WHERE org_id = $1 AND content_version_id = $2 ORDER BY ordinal`,
      [org.orgId, v],
    );
    expect(rows.length).toBe(3);
    for (const r of rows) expect(textSha256(r.text).toString('hex'), r.text).toBe(r.hex);
    expect(rows[1]!.text).toBe('lone � surrogate');
  });

  it('reconciliation re-embeds vectors lost to garbage collection; GC removes only unreferenced vectors; readiness is per org', async () => {
    reset();
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    blocks = Array.from({ length: 4 }, (_, i) => ({
      text: `Reconcile paragraph ${i} unique text`,
      locator: { page: i + 1 },
    }));
    const c = ctx();
    const v = await upload(org, doc);
    await documentProcess(jobFor(org, doc, v), c);
    await embedVersion({ orgId: org.orgId, versionId: v }, c);
    expect(await db.embeddingCount(org)).toBe(4);
    const pin = await activePin(c);
    // A vector lost (as if a garbage collection raced the parse) and an orphan nobody references.
    await db.q(
      `DELETE FROM embedding WHERE org_id = $1 AND text_sha256 IN (SELECT text_sha256 FROM chunk WHERE org_id = $1 ORDER BY ordinal LIMIT 2)`,
      [org.orgId],
    );
    await db.q(
      `INSERT INTO embedding (org_id, text_sha256, pin_id, vector) VALUES ($1, decode(repeat('ab', 32), 'hex'), $2, (SELECT vector FROM embedding WHERE org_id = $1 LIMIT 1))`,
      [org.orgId, pin.id],
    );
    expect(await db.embeddingCount(org)).toBe(3);
    embedCalls = [];
    const report = await reconcileOnce(c);
    const mine = report.orgs.find((o) => o.orgId === org.orgId)!;
    expect(mine).toMatchObject({ total: 4, covered: 4, ready: true, gcRemoved: 1, embedded: 2 });
    expect(await db.embeddingCount(org)).toBe(4);
    expect(
      await db.q(
        `SELECT 1 FROM embedding WHERE org_id = $1 AND text_sha256 = decode(repeat('ab', 32), 'hex')`,
        [org.orgId],
      ),
    ).toHaveLength(0);
  });

  it('clip chunk backfill pauses with the flag and reports readiness per org', async () => {
    reset();
    const org = await db.seedOrg(false);
    const clip = await db.createContent(org, 'clip');
    const v = (
      await db.q<{ id: string }>(
        `INSERT INTO content_version (org_id, content_id, status, original_key, mime_type) VALUES ($1, $2, 'current', 'k', 'video/mp4') RETURNING id`,
        [org.orgId, clip],
      )
    )[0]!.id;
    await db.q(`UPDATE content SET current_version_id = $3 WHERE org_id = $1 AND id = $2`, [
      org.orgId,
      clip,
      v,
    ]);
    for (let i = 0; i < 3; i += 1)
      await db.q(
        `INSERT INTO chunk (org_id, content_version_id, content_id, locator, text, lang) VALUES ($1, $2, $3, '{"kind":"transcript"}'::jsonb, $4, 'en')`,
        [org.orgId, v, clip, `transcript window ${i} about quarterly planning`],
      );
    const c = ctx();
    let report = await reconcileOnce(c);
    expect(report.orgs.find((o) => o.orgId === org.orgId)).toMatchObject({
      total: 0,
      covered: 0,
      embedded: 0,
    });
    expect(embedCalls.flat().some((t) => t.includes('transcript window'))).toBe(false);
    expect(await db.embeddingCount(org)).toBe(0);
    await db.setFlag(org, true);
    report = await reconcileOnce(c);
    expect(report.orgs.find((o) => o.orgId === org.orgId)).toMatchObject({
      total: 3,
      covered: 3,
      ready: true,
      embedded: 3,
    });
    expect(await db.embeddingCount(org)).toBe(3);
    await db.setFlag(org, false); // pauses again
    await db.q(`DELETE FROM embedding WHERE org_id = $1`, [org.orgId]);
    embedCalls = [];
    await reconcileOnce(c);
    expect(embedCalls.flat().some((t) => t.includes('transcript window'))).toBe(false);
  });

  it('kill the worker mid re-embed: the restart finishes with no duplicate, missing or mixed-pin vectors (AC-3)', async () => {
    reset();
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    blocks = Array.from({ length: 14 }, (_, i) => ({
      text: `Kill test paragraph ${i} with distinct words ${i * 7919}`,
      locator: { page: i + 1 },
    }));
    const v = await upload(org, doc);
    const c = ctx();
    await documentProcess(jobFor(org, doc, v), c);
    expect(await db.embeddingCount(org)).toBe(0);
    const total = (await db.chunkTexts(org, v)).length;
    expect(total).toBeGreaterThanOrEqual(10);

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', new URL('./testing/embed-child.ts', import.meta.url).pathname],
      {
        env: {
          ...process.env,
          DATABASE_PLATFORM_URL: scratch.platformUrl,
          ORG_ID: org.orgId,
          VERSION_ID: v,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    let seen = 0;
    for (let i = 0; i < 200 && seen < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      seen = await db.embeddingCount(org);
    }
    expect(seen, `child output: ${out}`).toBeGreaterThanOrEqual(4);
    child.kill('SIGKILL');
    expect(await exited).toBeNull(); // killed by the signal, not finished
    const afterKill = await db.embeddingCount(org);
    expect(afterKill).toBeGreaterThanOrEqual(4);
    expect(afterKill).toBeLessThan(total);

    embedCalls = [];
    await embedVersion({ orgId: org.orgId, versionId: v }, c);
    // Only the missing texts are embedded again: nothing already stored is re-embedded.
    expect(embedCalls.flat()).toHaveLength(total - afterKill);
    expect(await db.embeddingCount(org)).toBe(total);
    const dup = await db.q(
      `SELECT text_sha256 FROM embedding WHERE org_id = $1 GROUP BY text_sha256, pin_id HAVING count(*) > 1`,
      [org.orgId],
    );
    expect(dup).toEqual([]);
    const pin = await activePin(c);
    expect(await db.embeddingCount(org, pin.id)).toBe(total);
    const missing = await db
      .q(`SELECT platform_embedding_missing_hashes($1, $2, $3) AS h`, [org.orgId, v, pin.id])
      .catch(() => []);
    void missing;
    embedCalls = [];
    await embedVersion({ orgId: org.orgId, versionId: v }, c);
    expect(embedCalls).toEqual([]); // fully recovered: a third run has nothing to do
  });

  it('shadow pin: fill while the active pin stays, refuse an unready switch, then switch atomically (AC-3)', async () => {
    reset();
    const org = await db.seedOrg();
    const doc = await db.createContent(org, 'document');
    blocks = Array.from({ length: 3 }, (_, i) => ({
      text: `Pin flow paragraph ${i} content`,
      locator: { page: i + 1 },
    }));
    const v = await upload(org, doc);
    const c = ctx();
    await documentProcess(jobFor(org, doc, v), c);
    await embedVersion({ orgId: org.orgId, versionId: v }, c);
    const before = await activePin(c);

    const shadowModel = 'fake-b';
    runtimeProviders = [provider(), provider(shadowModel)];
    const c2 = ctx();
    const reg = await db.platform.query<{ id: string }>(
      'SELECT platform_embedding_pin_register($1, 1024) AS id',
      [shadowModel],
    );
    const shadow = { id: reg.rows[0]!.id, model: shadowModel, dims: 1024 };
    // Not ready: the switch is refused (failing control) and the active pin is unchanged.
    await expect(switchPin(c2, shadow.id)).rejects.toThrow(/not ready/);
    expect(await activePin(c2)).toEqual(before);

    const idx = await ensurePinIndex(scratch.adminUrl, shadow.id);
    expect(idx.valid).toBe(true);
    const idx2 = await ensurePinIndex(scratch.adminUrl, shadow.id); // idempotent
    expect(idx2).toMatchObject({ action: 'kept', valid: true });

    // Coverage incomplete: ready row says so and the switch still refuses.
    expect(await markReady(c2, shadow.id)).toMatchObject({
      indexValid: true,
      coverageComplete: false,
    });
    await expect(switchPin(c2, shadow.id)).rejects.toThrow(/not ready/);

    const filled = await fillPin(c2, shadow);
    expect(filled.written).toBeGreaterThanOrEqual(3);
    expect(await db.embeddingCount(org, shadow.id)).toBe(3);
    expect(await db.embeddingCount(org, before.id)).toBe(3); // active pin vectors untouched
    expect(await activePin(c2)).toEqual(before); // retrieval still on the active pin during the fill
    const mixed = await db.q(
      `SELECT count(*)::int AS n FROM embedding e WHERE org_id = $1 AND pin_id NOT IN ($2, $3)`,
      [org.orgId, before.id, shadow.id],
    );
    expect(mixed[0]).toMatchObject({ n: 0 });

    expect(await markReady(c2, shadow.id)).toMatchObject({
      indexValid: true,
      coverageComplete: true,
    });
    await switchPin(c2, shadow.id);
    expect((await activePin(c2)).id).toBe(shadow.id);
    const states = await db.q<{ state: string }>(
      `SELECT state FROM platform.embedding_pin WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[before.id, shadow.id]],
    );
    expect(states.map((s) => s.state).sort()).toEqual(['active', 'shadow']);
    runtimeProviders = [provider()];
  });
});
