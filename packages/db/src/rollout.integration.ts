// SPDX-License-Identifier: AGPL-3.0-only
// M2a core, deployment-global behaviour: the migration runner from an empty database and from the 0012
// state, the org flag and kill switch, rollback (hide, flag record) and roll-forward (restore), the
// embedding pin, the embedding table and its definer functions. These toggle state that is global to a
// database (kill switch, pins, flag record), so the whole suite runs in its own scratch databases.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrationsDir, runMigrations } from './migrate.js';
import { lintSchema } from './schema-lint.js';
import { ensurePinIndex, reportPinReadiness } from './pin-index.js';
import { withTenant } from './tenant.js';
import {
  createScratchDatabase,
  makeHarness,
  sampleChunks,
  sha256Nfc,
  unitVector,
  waitForLockWait,
  type Harness,
  type Scratch,
  type TestOrg,
} from './test-support.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const appUrl = process.env['DATABASE_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL'];
const enabled = Boolean(adminUrl && appUrl && platformUrl);
const DEFAULT_PIN = '5a7e0001-0000-4000-8000-000000000001';

describe.skipIf(!enabled)('migration 0013 on both starting states (integration)', () => {
  const scratch: Scratch[] = [];
  afterAll(async () => {
    for (const s of scratch) await s.drop();
  });

  it('runs from an empty database with the real runner, is idempotent and lints clean', async () => {
    const s = await createScratchDatabase(adminUrl!, appUrl!, platformUrl!, 'm2a_empty');
    scratch.push(s);
    const first = await runMigrations(s.adminUrl);
    expect(first.applied).toContain('0013_m2a_documents_core.sql');
    expect(first.applied.length).toBeGreaterThanOrEqual(13);
    const second = await runMigrations(s.adminUrl);
    expect(second.applied).toEqual([]);
    expect(await lintSchema(s.adminUrl)).toEqual([]);
    const c = new pg.Client({ connectionString: s.adminUrl });
    await c.connect();
    try {
      const pin = await c.query<{ id: string; model: string; state: string }>(
        'SELECT id, model, state FROM platform.embedding_pin',
      );
      expect(pin.rows).toEqual([
        { id: DEFAULT_PIN, model: 'Qwen3-Embedding-0.6B', state: 'active' },
      ]);
      const idx = await c.query<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'embedding_hnsw_5a7e0001'`,
      );
      expect(idx.rows).toEqual([{ valid: true }]);
      const ks = await c.query<{ engaged: boolean }>(
        'SELECT engaged FROM platform.documents_kill_switch',
      );
      expect(ks.rows).toEqual([{ engaged: false }]);
    } finally {
      await c.end();
    }
  });

  it('runs from the 0012 state: backfills ordinal and hash by locator start then id, and clip indexing still works', async () => {
    const s = await createScratchDatabase(adminUrl!, appUrl!, platformUrl!, 'm2a_0012');
    scratch.push(s);
    // The 0012 state: every migration file except 0013.
    const dir = mkdtempSync(join(tmpdir(), 'm2a-mig-'));
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql') && x < '0013'))
      copyFileSync(join(migrationsDir, f), join(dir, f));
    const pre = await runMigrations(s.adminUrl, dir);
    expect(pre.applied.at(-1)).toMatch(/^0012_/);
    const c = new pg.Client({ connectionString: s.adminUrl });
    await c.connect();
    const org = randomUUID();
    const user = randomUUID();
    const content = randomUUID();
    const version = randomUUID();
    try {
      await c.query(`INSERT INTO org (id, slug, name) VALUES ($1, 's', 's')`, [org]);
      await c.query(
        `INSERT INTO platform.user_account (id, email, email_normalized, display_name) VALUES ($1, 'u@example.invalid', 'u@example.invalid', 'u')`,
        [user],
      );
      await c.query(`INSERT INTO org_membership (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        org,
        user,
      ]);
      await c.query(
        `INSERT INTO content (org_id, id, kind, owner_id, title) VALUES ($1, $2, 'clip', $3, 't')`,
        [org, content, user],
      );
      await c.query(
        `INSERT INTO content_version (org_id, id, content_id, status) VALUES ($1, $2, $3, 'uploaded')`,
        [org, version, content],
      );
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      // Out-of-order starts, one locator without a start (sorts last), and NFD text.
      const rows: Array<[string, string, object]> = [
        [ids[0]!, 'third chunk', { kind: 'transcript', start_ms: 30000 }],
        [ids[1]!, 'first chunk', { kind: 'transcript', start_ms: 0 }],
        [ids[2]!, 'café second', { kind: 'transcript', start_ms: 4000 }],
        [ids[3]!, 'no start', { t: 1 }],
      ];
      for (const [id, text, loc] of rows)
        await c.query(
          `INSERT INTO chunk (org_id, id, content_version_id, content_id, text, locator) VALUES ($1, $2, $3, $4, $5, $6)`,
          [org, id, version, content, text, JSON.stringify(loc)],
        );
    } finally {
      await c.end();
    }
    const post = await runMigrations(s.adminUrl);
    expect(post.applied).toEqual(['0013_m2a_documents_core.sql']);
    const d = new pg.Client({ connectionString: s.adminUrl });
    await d.connect();
    try {
      const r = await d.query<{ text: string; ordinal: number; text_sha256: Buffer }>(
        'SELECT text, ordinal, text_sha256 FROM chunk WHERE content_version_id = $1 ORDER BY ordinal',
        [version],
      );
      expect(r.rows.map((x) => [x.ordinal, x.text])).toEqual([
        [1, 'first chunk'],
        [2, 'café second'],
        [3, 'third chunk'],
        [4, 'no start'],
      ]);
      for (const x of r.rows) expect(x.text_sha256.equals(sha256Nfc(x.text))).toBe(true);
      const cols = await d.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'chunk' AND column_name IN ('ordinal', 'text_sha256')`,
      );
      expect(cols.rows.every((x) => x.is_nullable === 'NO' && x.column_default === null)).toBe(
        true,
      );
      // Clip transcript chunk creation after the migration.
      const v2 = randomUUID();
      await d.query(
        `INSERT INTO content_version (org_id, id, content_id, status, transcript) VALUES ($1, $2, $3, 'current', $4::jsonb)`,
        [
          org,
          v2,
          (await d.query<{ id: string }>('SELECT id FROM content LIMIT 1')).rows[0]!.id,
          JSON.stringify({
            language: 'en',
            segments: [
              { start_ms: 0, end_ms: 3000, text: 'hello world' },
              { start_ms: 25000, end_ms: 28000, text: 'second window' },
            ],
          }),
        ],
      );
      const t = await d.query<{ ordinal: number; text: string; text_sha256: Buffer }>(
        'SELECT ordinal, text, text_sha256 FROM chunk WHERE content_version_id = $1 ORDER BY ordinal',
        [v2],
      );
      expect(t.rows.map((x) => x.ordinal)).toEqual([1, 2]);
      for (const x of t.rows) expect(x.text_sha256.equals(sha256Nfc(x.text))).toBe(true);
    } finally {
      await d.end();
    }
    expect(await lintSchema(s.adminUrl)).toEqual([]);
    expect((await runMigrations(s.adminUrl)).applied).toEqual([]);
  });
});

describe.skipIf(!enabled)('flag, kill switch, rollback and restore (integration)', () => {
  let scratch: Scratch;
  let h: Harness;

  beforeAll(async () => {
    scratch = await createScratchDatabase(adminUrl!, appUrl!, platformUrl!, 'm2a_flags');
    await runMigrations(scratch.adminUrl);
    h = await makeHarness(scratch.adminUrl, scratch.appUrl, scratch.platformUrl);
  });
  afterAll(async () => {
    await h.close();
    await scratch.drop();
  });

  const gate = (o: TestOrg, asOrg: string = o.orgId) =>
    withTenant(h.app, { orgId: o.orgId, userId: o.member }, async (c) => {
      const r = await c.query<{ e: boolean }>('SELECT platform_documents_enabled($1) AS e', [
        asOrg,
      ]);
      return r.rows[0]!.e;
    });
  const epoch = async (o: TestOrg) =>
    withTenant(h.app, { orgId: o.orgId, userId: o.member }, async (c) =>
      Number(
        (await c.query<{ e: string }>('SELECT current_org_content_epoch($1)::text AS e', [o.orgId]))
          .rows[0]!.e,
      ),
    );
  const flagOf = async (o: TestOrg) =>
    (
      await h.admin.query<{ v: string | null }>(
        `SELECT settings ->> 'documents_enabled' AS v FROM org WHERE id = $1`,
        [o.orgId],
      )
    ).rows[0]!.v;

  it('platform_documents_enabled: flag true, false, absent (off), kill switch overrides, org context is asserted', async () => {
    const on = await h.seedOrg({ documentsEnabled: true });
    const off = await h.seedOrg({ documentsEnabled: false });
    const none = await h.seedOrg({ documentsEnabled: null });
    expect(await gate(on)).toBe(true);
    expect(await gate(off)).toBe(false);
    expect(await gate(none)).toBe(false);
    // A string "true" written by an old settings path also counts; any other value is off (fail closed).
    await h.admin.query(
      `UPDATE org SET settings = settings || '{"documents_enabled": "yes"}' WHERE id = $1`,
      [on.orgId],
    );
    expect(await gate(on)).toBe(false);
    await h.admin.query(
      `UPDATE org SET settings = settings || '{"documents_enabled": true}' WHERE id = $1`,
      [on.orgId],
    );
    await expect(gate(on, off.orgId)).rejects.toThrow(/org context mismatch/);
    const noCtx = await h.app.connect();
    try {
      await expect(
        noCtx.query('SELECT platform_documents_enabled($1)', [on.orgId]),
      ).rejects.toThrow(/org context mismatch/);
    } finally {
      noCtx.release();
    }
    await h.admin.query('SELECT platform_documents_kill_switch_set(true)');
    expect(await gate(on)).toBe(false);
    const engaged = await h.app.query<{ e: boolean }>(
      'SELECT platform_documents_kill_switch_engaged() AS e',
    );
    expect(engaged.rows[0]!.e).toBe(true);
    await h.admin.query('SELECT platform_documents_kill_switch_set(false)');
    expect(await gate(on)).toBe(true);
  });

  it('the app role can neither toggle the kill switch, call the unchecked gate, set flags for all orgs nor read the switch table', async () => {
    await expect(h.app.query('SELECT platform_documents_kill_switch_set(true)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      h.app.query('SELECT documents_enabled_unchecked(gen_random_uuid())'),
    ).rejects.toThrow(/permission denied/);
    await expect(h.app.query('SELECT platform_documents_flag_set_all(false)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(h.app.query('SELECT * FROM platform.documents_kill_switch')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('every flag change and the kill switch advance the org epoch of the affected orgs', async () => {
    const a = await h.seedOrg({ documentsEnabled: true });
    const b = await h.seedOrg({ documentsEnabled: true });
    const a0 = await epoch(a);
    await h.admin.query(
      `UPDATE org SET settings = settings || '{"documents_enabled": false}' WHERE id = $1`,
      [a.orgId],
    );
    const a1 = await epoch(a);
    expect(a1).toBeGreaterThan(a0);
    // An unrelated settings edit does not advance it.
    await h.admin.query(
      `UPDATE org SET settings = settings || '{"comments": {"enabled": true}}' WHERE id = $1`,
      [a.orgId],
    );
    expect(await epoch(a)).toBe(a1);
    const b0 = await epoch(b);
    await h.admin.query('SELECT platform_documents_kill_switch_set(true)');
    expect(await epoch(b)).toBeGreaterThan(b0);
    expect(await epoch(a)).toBeGreaterThan(a1);
    await h.admin.query('SELECT platform_documents_kill_switch_set(false)');
  });

  it('flag_init_missing writes the default only where the key is absent', async () => {
    const on = await h.seedOrg({ documentsEnabled: true });
    const off = await h.seedOrg({ documentsEnabled: false });
    const none = await h.seedOrg({ documentsEnabled: null });
    const r = await h.platform.query<{ n: number }>(
      'SELECT platform_documents_flag_init_missing(true) AS n',
    );
    expect(r.rows[0]!.n).toBeGreaterThanOrEqual(1);
    expect(await flagOf(on)).toBe('true');
    expect(await flagOf(off)).toBe('false');
    expect(await flagOf(none)).toBe('true');
  });

  it('flag_set_all(false) records every org first, keeps the original record on a repeat, and restore_all puts values back (absent stays absent)', async () => {
    const on = await h.seedOrg({ documentsEnabled: true });
    const off = await h.seedOrg({ documentsEnabled: false });
    const none = await h.seedOrg({ documentsEnabled: null });
    const e0 = await epoch(on);
    await h.platform.query('SELECT platform_documents_flag_set_all(false)');
    for (const o of [on, off, none]) expect(await flagOf(o)).toBe('false');
    expect(await epoch(on)).toBeGreaterThan(e0);
    // Repeat while an unrestored record exists: the original values are kept.
    await h.platform.query('SELECT platform_documents_flag_set_all(false)');
    const rec = await h.admin.query<{
      org_id: string;
      prior_present: boolean;
      prior_value: unknown;
    }>(
      'SELECT org_id, prior_present, prior_value FROM platform.documents_flag_record WHERE org_id = ANY($1)',
      [[on.orgId, off.orgId, none.orgId]],
    );
    const byOrg = Object.fromEntries(rec.rows.map((r) => [r.org_id, r]));
    expect(byOrg[on.orgId]).toMatchObject({ prior_present: true, prior_value: true });
    expect(byOrg[off.orgId]).toMatchObject({ prior_present: true, prior_value: false });
    expect(byOrg[none.orgId]).toMatchObject({ prior_present: false });
    // An old-build settings edit that drops the key is fail-closed.
    await h.admin.query(`UPDATE org SET settings = settings - 'documents_enabled' WHERE id = $1`, [
      on.orgId,
    ]);
    expect(await gate(on)).toBe(false);
    await h.platform.query('SELECT platform_documents_flag_restore_all()');
    expect(await flagOf(on)).toBe('true');
    expect(await flagOf(off)).toBe('false');
    expect(await flagOf(none)).toBeNull();
    expect(await gate(on)).toBe(true);
    const again = await h.platform.query<{ n: number }>(
      'SELECT platform_documents_flag_restore_all() AS n',
    );
    expect(again.rows[0]!.n).toBe(0); // idempotent
  });

  describe('hide and restore', () => {
    async function mkDoc(
      o: TestOrg,
      state: 'live' | 'scheduled' | 'draft' | 'processing' | 'retracted',
    ) {
      const content = await h.createDocument(o);
      const v = await h.initVersion(o, content);
      await h.complete(o, content, v);
      if (state !== 'processing') await h.finish(o, v, await h.claim(o, v), sampleChunks(2));
      if (state === 'live') await h.publish(o, content);
      if (state === 'scheduled')
        await h.publish(
          o,
          content,
          new Date(Date.now() + 3 * 3_600_000),
          new Date(Date.now() + 5 * 3_600_000),
        );
      if (state === 'processing') await h.publish(o, content);
      if (state === 'retracted') await h.retract(o, content);
      return { content, version: v };
    }
    const row = async (o: TestOrg, content: string) =>
      (
        await h.admin.query<{
          state: string;
          publish_at: Date | null;
          expires_at: Date | null;
          updated_at: Date;
        }>(
          'SELECT state::text, publish_at, expires_at, updated_at FROM content WHERE org_id = $1 AND id = $2',
          [o.orgId, content],
        )
      ).rows[0]!;

    it('hides only previously published documents (live, scheduled, processing), records their schedule, skips drafts and retracted, and is idempotent', async () => {
      const o = await h.seedOrg({ documentsEnabled: true });
      const clip = await h.createClip(o);
      await h.publish(o, clip);
      const live = await mkDoc(o, 'live');
      const sched = await mkDoc(o, 'scheduled');
      const proc = await mkDoc(o, 'processing');
      const draft = await mkDoc(o, 'draft');
      const dead = await mkDoc(o, 'retracted');
      const liveBefore = await row(o, live.content);
      const schedBefore = await row(o, sched.content);
      const e0 = await epoch(o);
      const n = await h.platform.query<{ n: number }>('SELECT platform_documents_hide() AS n');
      expect(n.rows[0]!.n).toBeGreaterThanOrEqual(3);
      expect((await row(o, live.content)).state).toBe('draft');
      expect((await row(o, sched.content)).state).toBe('draft');
      expect((await row(o, proc.content)).state).toBe('draft');
      expect((await row(o, draft.content)).state).toBe('draft');
      expect((await row(o, dead.content)).state).toBe('retracted');
      expect((await row(o, clip)).state).toBe('published'); // clips are never touched
      expect(await epoch(o)).toBeGreaterThan(e0);
      const rec = await h.admin.query<{
        content_id: string;
        prior_publish_at: Date;
        prior_expires_at: Date | null;
        hidden_updated_at: Date;
      }>(
        'SELECT content_id, prior_publish_at, prior_expires_at, hidden_updated_at FROM platform.documents_hide_record WHERE org_id = $1',
        [o.orgId],
      );
      const recs = Object.fromEntries(rec.rows.map((r) => [r.content_id, r]));
      expect(Object.keys(recs).sort()).toEqual([live.content, sched.content, proc.content].sort()); // never the draft or the retracted one
      expect(recs[live.content]!.prior_publish_at.getTime()).toBe(liveBefore.publish_at!.getTime());
      expect(recs[sched.content]!.prior_publish_at.getTime()).toBe(
        schedBefore.publish_at!.getTime(),
      );
      expect(recs[sched.content]!.prior_expires_at!.getTime()).toBe(
        schedBefore.expires_at!.getTime(),
      );
      expect(recs[live.content]!.hidden_updated_at.getTime()).toBe(
        (await row(o, live.content)).updated_at.getTime(),
      );
      const audit = await h.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event WHERE org_id = $1 AND action = 'documents.hidden'`,
        [o.orgId],
      );
      expect(audit.rows[0]!.n).toBe(1);
      // Idempotent: nothing left to hide in this org.
      await h.platform.query('SELECT platform_documents_hide()');
      const after = await h.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM platform.documents_hide_record WHERE org_id = $1',
        [o.orgId],
      );
      expect(after.rows[0]!.n).toBe(3);
    });

    it('restore puts documents back with their prior schedule, skips modified, retracted and republished ones, re-emits events once and never touches drafts', async () => {
      const o = await h.seedOrg({ documentsEnabled: true });
      const live = await mkDoc(o, 'live');
      const sched = await mkDoc(o, 'scheduled');
      const edited = await mkDoc(o, 'live');
      const killed = await mkDoc(o, 'live');
      const republished = await mkDoc(o, 'live');
      const draft = await mkDoc(o, 'draft');
      const liveBefore = await row(o, live.content);
      const schedBefore = await row(o, sched.content);
      await h.platform.query('SELECT platform_documents_hide()');
      // Changes during the window: an edit, a retraction, a republish by an author on the previous build path.
      await h.admin.query(
        `UPDATE content SET title = 'edited during the window' WHERE org_id = $1 AND id = $2`,
        [o.orgId, edited.content],
      );
      await h.retract(o, killed.content);
      await h.admin.query(
        `UPDATE content SET state = 'published', publish_at = now() WHERE org_id = $1 AND id = $2`,
        [o.orgId, republished.content],
      );
      const before = (await h.events(o, live.content, 'content.published')).length;
      const r = await h.platform.query<{ content_id: string; outcome: string }>(
        'SELECT content_id, outcome FROM platform_documents_restore()',
      );
      const out = Object.fromEntries(
        r.rows
          .filter((x) =>
            [live, sched, edited, killed, republished].some((d) => d.content === x.content_id),
          )
          .map((x) => [x.content_id, x.outcome]),
      );
      expect(out[live.content]).toBe('restored');
      expect(out[sched.content]).toBe('restored');
      expect(out[edited.content]).toBe('skipped_modified');
      expect(out[killed.content]).toBe('skipped_retracted');
      expect(out[republished.content]).toBe('skipped_not_draft');
      const lr = await row(o, live.content);
      expect(lr.state).toBe('published');
      expect(lr.publish_at!.getTime()).toBe(liveBefore.publish_at!.getTime());
      const sr = await row(o, sched.content);
      expect(sr.state).toBe('published');
      expect(sr.publish_at!.getTime()).toBe(schedBefore.publish_at!.getTime());
      expect(sr.expires_at!.getTime()).toBe(schedBefore.expires_at!.getTime());
      expect((await row(o, edited.content)).state).toBe('draft');
      expect((await row(o, killed.content)).state).toBe('retracted');
      expect((await row(o, draft.content)).state).toBe('draft'); // never published, never restored
      // Events: a live document is re-announced for its current version; a still-future one is re-scheduled.
      const pub = await h.events(o, live.content, 'content.published');
      expect(pub.length).toBe(before + 1);
      expect(pub.at(-1)).toMatchObject({
        version_id: live.version,
        payload: { source: 'documents_restore' },
      });
      expect((await h.events(o, sched.content, 'content.published')).length).toBe(0);
      expect((await h.events(o, sched.content, 'content.scheduled')).length).toBe(1);
      expect((await h.events(o, sched.content, 'content.expiry_scheduled')).length).toBe(1);
      // A second restore finds nothing new for restored rows and emits nothing more.
      const again = await h.platform.query<{ content_id: string; outcome: string }>(
        'SELECT content_id, outcome FROM platform_documents_restore()',
      );
      expect(again.rows.filter((x) => x.outcome === 'restored')).toEqual([]);
      expect((await h.events(o, live.content, 'content.published')).length).toBe(before + 1);
      // The notification layer dedupes by published:<version>: a second fan-out for the same version inserts nothing.
      const dedupe = `published:${live.version}`;
      const first = await h.platform.query<{ r: boolean }>(
        `SELECT platform_notify($1, $2, 'content.published', 'audience', $3, $4, NULL, $5, '{}'::jsonb) AS r`,
        [o.orgId, o.member, live.content, live.version, dedupe],
      );
      const second = await h.platform.query<{ r: boolean }>(
        `SELECT platform_notify($1, $2, 'content.published', 'audience', $3, $4, NULL, $5, '{}'::jsonb) AS r`,
        [o.orgId, o.member, live.content, live.version, dedupe],
      );
      expect([first.rows[0]!.r, second.rows[0]!.r]).toEqual([true, false]);
      const audit = await h.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event WHERE org_id = $1 AND action = 'documents.restored'`,
        [o.orgId],
      );
      expect(audit.rows[0]!.n).toBe(1);
    });

    it('rollback window: with the flag off a draft document with a current version cannot be published, upload bounds hold on the old worker path, then roll-forward restores', async () => {
      const o = await h.seedOrg({ documentsEnabled: true });
      const draft = await mkDoc(o, 'draft'); // a draft with a current version
      const live = await mkDoc(o, 'live');
      // (0) kill switch, (1) flags off for every org, (2) hide.
      await h.platform.query('SELECT platform_documents_kill_switch_set(true)');
      await h.platform.query('SELECT platform_documents_flag_set_all(false)');
      await h.platform.query('SELECT platform_documents_hide()');
      // An org admin cannot flip the flag on during the window: the gate stays false (kill switch).
      await h.admin.query(
        `UPDATE org SET settings = settings || '{"documents_enabled": true}' WHERE id = $1`,
        [o.orgId],
      );
      expect(await gate(o)).toBe(false);
      await h.admin.query(
        `UPDATE org SET settings = settings || '{"documents_enabled": false}' WHERE id = $1`,
        [o.orgId],
      );
      // The previous build cannot publish the draft document: the guard refuses it.
      await expect(h.publish(o, draft.content)).rejects.toThrow(/feature_disabled/);
      expect((await row(o, draft.content)).state).toBe('draft');
      // (4) previous worker build: it can never move a document version.
      const nv = await h.initVersion(o, live.content);
      await h.admin.query(
        `UPDATE content_version SET processing_step = 'uploaded' WHERE org_id = $1 AND id = $2`,
        [o.orgId, nv],
      );
      await h.platform.query(
        `SELECT platform_version_update($1, $2, 'current', 'done', NULL, NULL, NULL, NULL)`,
        [o.orgId, nv],
      );
      expect((await h.version(o, nv)).status).toBe('uploaded');
      expect(await h.currentVersionId(o, live.content)).toBe(live.version);
      // Clips keep working: publish, index and the old-style current switch.
      const clip = await h.createClip(o);
      const cv = await h.initVersion(o, clip);
      await h.publish(o, clip);
      await h.platform.query(
        `SELECT platform_version_update($1, $2, 'current', 'done', NULL, NULL, $3::jsonb, NULL)`,
        [
          o.orgId,
          cv,
          JSON.stringify({
            language: 'en',
            segments: [{ start_ms: 0, end_ms: 2000, text: 'clip words' }],
          }),
        ],
      );
      expect(await h.chunkCount(o, cv)).toBe(1);
      // Roll-forward: clear the switch, restore flags, restore documents.
      await h.platform.query('SELECT platform_documents_kill_switch_set(false)');
      await h.platform.query('SELECT platform_documents_flag_restore_all()');
      const r = await h.platform.query<{ content_id: string; outcome: string }>(
        'SELECT content_id, outcome FROM platform_documents_restore()',
      );
      expect(r.rows.find((x) => x.content_id === live.content)?.outcome).toBe('restored');
      expect(await gate(o)).toBe(true);
      expect((await row(o, live.content)).state).toBe('published');
      expect((await row(o, draft.content)).state).toBe('draft');
    });
  });
});

describe.skipIf(!enabled)('embeddings: pin, table and definer functions (integration)', () => {
  let scratch: Scratch;
  let h: Harness;
  let org: TestOrg;

  beforeAll(async () => {
    scratch = await createScratchDatabase(adminUrl!, appUrl!, platformUrl!, 'm2a_embed');
    await runMigrations(scratch.adminUrl);
    h = await makeHarness(scratch.adminUrl, scratch.appUrl, scratch.platformUrl);
    org = await h.seedOrg();
  });
  afterAll(async () => {
    await h.close();
    await scratch.drop();
  });

  async function liveDoc(o: TestOrg, texts: string[]) {
    const content = await h.createDocument(o);
    const version = await h.initVersion(o, content);
    await h.complete(o, content, version);
    const chunks = texts.map((text, i) => ({ locator: { page: i + 1 }, text }));
    expect(await h.finish(o, version, await h.claim(o, version), chunks)).toBe('ok');
    return { content, version };
  }
  const missing = async (o: TestOrg, version: string, pin = DEFAULT_PIN) =>
    (
      await h.platform.query<{ h: Buffer }>(
        'SELECT platform_embedding_missing_hashes($1, $2, $3) AS h',
        [o.orgId, version, pin],
      )
    ).rows.map((r) => r.h);
  const upsert = async (o: TestOrg, hash: Buffer, pin: string, vec: string) =>
    (
      await h.platform.query<{ r: boolean }>(
        'SELECT platform_embedding_upsert($1, $2, $3, $4::vector) AS r',
        [o.orgId, hash, pin, vec],
      )
    ).rows[0]!.r;
  const vectorCount = async (o: TestOrg, pin?: string) =>
    (
      await h.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM embedding WHERE org_id = $1 AND ($2::uuid IS NULL OR pin_id = $2)',
        [o.orgId, pin ?? null],
      )
    ).rows[0]!.n;

  it('the default pin is active, one active pin only, and the app role reads it only through the definer function', async () => {
    const r = await h.app.query<{ id: string; model: string; dims: number }>(
      'SELECT id, model, dims FROM platform_embedding_active_pin()',
    );
    expect(r.rows).toEqual([{ id: DEFAULT_PIN, model: 'Qwen3-Embedding-0.6B', dims: 1024 }]);
    await expect(h.app.query('SELECT * FROM platform.embedding_pin')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      h.admin.query(
        `INSERT INTO platform.embedding_pin (id, model, dims, state) VALUES (gen_random_uuid(), 'x', 1024, 'active')`,
      ),
    ).rejects.toThrow(/embedding_pin_one_active_idx/);
    await expect(
      h.admin.query(
        `INSERT INTO platform.embedding_pin (id, model, dims, state) VALUES (gen_random_uuid(), 'x', 768, 'shadow')`,
      ),
    ).rejects.toThrow(/check/);
  });

  it('upsert: keyed by (org, hash, pin), idempotent, refuses zero vectors, wrong dimensions, unknown or retired pins and hashes no chunk references; app role cannot call it', async () => {
    const { version } = await liveDoc(org, ['unique text one', 'unique text two']);
    const hashes = await missing(org, version);
    expect(hashes).toHaveLength(2);
    expect(hashes.map((x) => x.toString('hex')).sort()).toEqual(
      [sha256Nfc('unique text one'), sha256Nfc('unique text two')]
        .map((x) => x.toString('hex'))
        .sort(),
    );
    expect(await upsert(org, hashes[0]!, DEFAULT_PIN, unitVector(1))).toBe(true);
    expect(await upsert(org, hashes[0]!, DEFAULT_PIN, unitVector(2))).toBe(false); // idempotent: no duplicate, no overwrite
    expect(await vectorCount(org, DEFAULT_PIN)).toBe(1);
    await expect(
      upsert(org, hashes[1]!, DEFAULT_PIN, `[${new Array(1024).fill(0).join(',')}]`),
    ).rejects.toThrow(/zero or missing vector/);
    await expect(upsert(org, hashes[1]!, DEFAULT_PIN, '[1,2,3]')).rejects.toThrow(/dimensions/);
    await expect(upsert(org, hashes[1]!, randomUUID(), unitVector(3))).rejects.toThrow(
      /pin is not active or shadow|violates foreign key/,
    );
    await expect(upsert(org, Buffer.alloc(31), DEFAULT_PIN, unitVector(3))).rejects.toThrow(
      /32 bytes/,
    );
    expect(await upsert(org, sha256Nfc('text nobody references'), DEFAULT_PIN, unitVector(4))).toBe(
      false,
    );
    await expect(
      h.app.query('SELECT platform_embedding_upsert($1, $2, $3, $4::vector)', [
        org.orgId,
        hashes[1],
        DEFAULT_PIN,
        unitVector(5),
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      h.app.query(
        'INSERT INTO embedding (org_id, text_sha256, pin_id, vector) VALUES ($1, $2, $3, $4::vector)',
        [org.orgId, hashes[1], DEFAULT_PIN, unitVector(5)],
      ),
    ).rejects.toThrow(/permission denied/);
    // Direct insert for a retired pin is rejected by the trigger even for the owner.
    const retired = (
      await h.platform.query<{ id: string }>(
        `SELECT platform_embedding_pin_register('retire-me', 1024) AS id`,
      )
    ).rows[0]!.id;
    await h.platform.query('SELECT platform_embedding_pin_retire($1)', [retired]);
    await expect(
      h.admin.query(
        'INSERT INTO embedding (org_id, text_sha256, pin_id, vector) VALUES ($1, $2, $3, $4::vector)',
        [org.orgId, hashes[1], retired, unitVector(6)],
      ),
    ).rejects.toThrow(/pin is not active or shadow/);
  });

  it('reindex or replacement with unchanged text makes zero embed requests and loses no vectors; changed text makes exactly the new ones', async () => {
    const o = await h.seedOrg();
    const texts = ['shared one', 'shared two', 'shared three'];
    const { content, version: v1 } = await liveDoc(o, texts);
    const hs = await missing(o, v1);
    expect(hs).toHaveLength(3);
    for (const [i, x] of hs.entries()) await upsert(o, x, DEFAULT_PIN, unitVector(10 + i));
    expect(await missing(o, v1)).toHaveLength(0);
    // Replacement with identical text: zero missing.
    const v2 = await h.initVersion(o, content);
    await h.complete(o, content, v2);
    await h.finish(
      o,
      v2,
      await h.claim(o, v2),
      texts.map((text, i) => ({ locator: { page: i + 1 }, text })),
    );
    expect(await missing(o, v2)).toHaveLength(0);
    // Prune the superseded version and collect garbage: shared hashes stay, nothing is lost.
    await h.platform.query('SELECT platform_search_prune($1)', [o.orgId]);
    const gc = await h.platform.query<{ n: number }>('SELECT platform_embedding_gc($1) AS n', [
      o.orgId,
    ]);
    expect(gc.rows[0]!.n).toBe(0);
    expect(await vectorCount(o, DEFAULT_PIN)).toBe(3);
    // Replacement with one changed text: exactly one missing; after the next prune and gc the dropped text's vector goes.
    const v3 = await h.initVersion(o, content);
    await h.complete(o, content, v3);
    await h.finish(
      o,
      v3,
      await h.claim(o, v3),
      ['shared one', 'shared two', 'brand new three'].map((text, i) => ({
        locator: { page: i + 1 },
        text,
      })),
    );
    const need = await missing(o, v3);
    expect(need.map((x) => x.toString('hex'))).toEqual([
      sha256Nfc('brand new three').toString('hex'),
    ]);
    await h.platform.query('SELECT platform_search_prune($1)', [o.orgId]);
    const gc2 = await h.platform.query<{ n: number }>('SELECT platform_embedding_gc($1) AS n', [
      o.orgId,
    ]);
    expect(gc2.rows[0]!.n).toBe(1); // 'shared three' is no longer referenced by any chunk
    expect(await vectorCount(o, DEFAULT_PIN)).toBe(2);
  });

  it('missing_hashes, reconcile, chunk_text and coverage: current versions only, empty hashes ignored, nothing while the flag is off, bounded input', async () => {
    const o = await h.seedOrg();
    const { content, version } = await liveDoc(o, ['alpha text', 'beta text']);
    // An empty-text chunk exists but its hash is ignored.
    await h.admin.query(
      `INSERT INTO chunk (org_id, content_version_id, content_id, text, ordinal) VALUES ($1, $2, $3, '', 99)`,
      [o.orgId, version, content],
    );
    expect(await missing(o, version)).toHaveLength(2);
    const rec = await h.platform.query<{ h: Buffer }>(
      'SELECT platform_embedding_reconcile($1, $2, 100) AS h',
      [o.orgId, DEFAULT_PIN],
    );
    expect(rec.rows).toHaveLength(2);
    const hs = rec.rows.map((r) => r.h);
    const txt = await h.platform.query<{ text_sha256: Buffer; text: string }>(
      'SELECT * FROM platform_embedding_chunk_text($1, $2::bytea[])',
      [o.orgId, hs],
    );
    expect(txt.rows.map((r) => r.text).sort()).toEqual(['alpha text', 'beta text']);
    await expect(
      h.platform.query('SELECT * FROM platform_embedding_chunk_text($1, $2::bytea[])', [
        o.orgId,
        new Array(201).fill(hs[0]),
      ]),
    ).rejects.toThrow(/at most 200/);
    const cov0 = await h.platform.query<{ total: string; covered: string }>(
      'SELECT total, covered FROM platform_embedding_coverage($1, $2)',
      [o.orgId, DEFAULT_PIN],
    );
    expect(cov0.rows[0]).toEqual({ total: '2', covered: '0' });
    await upsert(o, hs[0]!, DEFAULT_PIN, unitVector(20));
    const cov1 = await h.platform.query<{ total: string; covered: string }>(
      'SELECT total, covered FROM platform_embedding_coverage($1, $2)',
      [o.orgId, DEFAULT_PIN],
    );
    expect(cov1.rows[0]).toEqual({ total: '2', covered: '1' });
    // A retracted document's chunk text is never served to an embed job.
    await h.retract(o, content);
    const after = await h.platform.query(
      'SELECT * FROM platform_embedding_chunk_text($1, $2::bytea[])',
      [o.orgId, hs],
    );
    expect(after.rowCount).toBe(0);
    // Flag off: nothing to embed, nothing to reconcile, no text.
    const o2 = await h.seedOrg();
    const d2 = await liveDoc(o2, ['gamma text']);
    expect(await missing(o2, d2.version)).toHaveLength(1);
    await h.admin.query(
      `UPDATE org SET settings = settings || '{"documents_enabled": false}' WHERE id = $1`,
      [o2.orgId],
    );
    expect(await missing(o2, d2.version)).toHaveLength(0);
    expect(
      (
        await h.platform.query('SELECT platform_embedding_reconcile($1, $2, 10)', [
          o2.orgId,
          DEFAULT_PIN,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await h.platform.query('SELECT * FROM platform_embedding_chunk_text($1, $2::bytea[])', [
          o2.orgId,
          [sha256Nfc('gamma text')],
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('RLS: the app role sees only its own org vectors and none without a tenant context', async () => {
    const a = await h.seedOrg();
    const b = await h.seedOrg();
    for (const [o, text, i] of [
      [a, 'rls text a', 30],
      [b, 'rls text b', 31],
    ] as const) {
      const { version } = await liveDoc(o, [text]);
      await upsert(o, (await missing(o, version))[0]!, DEFAULT_PIN, unitVector(i));
    }
    const seen = await withTenant(h.app, { orgId: a.orgId, userId: a.member }, async (c) =>
      (await c.query<{ org_id: string }>('SELECT org_id FROM embedding')).rows.map((r) => r.org_id),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([a.orgId]));
    expect((await h.app.query('SELECT 1 FROM embedding')).rowCount).toBe(0);
  });

  it('the HNSW index is valid and the planner uses it for a literal-pin cosine query', async () => {
    const o = await h.seedOrg();
    for (let i = 0; i < 40; i += 1) {
      const { version } = await liveDoc(o, [`vector corpus text ${i} ${randomUUID()}`]);
      await upsert(o, (await missing(o, version))[0]!, DEFAULT_PIN, unitVector(100 + i));
    }
    const c = new pg.Client({ connectionString: scratch.adminUrl });
    await c.connect();
    try {
      await c.query('SET enable_seqscan = off');
      const plan = await c.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT text_sha256 FROM embedding WHERE pin_id = '${DEFAULT_PIN}'::uuid ORDER BY vector <=> '${unitVector(100)}'::vector LIMIT 5`,
      );
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('embedding_hnsw_5a7e0001');
      // Control: a different pin literal cannot use the default pin's partial index.
      const other = await c.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT text_sha256 FROM embedding WHERE pin_id = '${randomUUID()}'::uuid ORDER BY vector <=> '${unitVector(100)}'::vector LIMIT 5`,
      );
      expect(other.rows.map((r) => r['QUERY PLAN']).join('\n')).not.toContain(
        'embedding_hnsw_5a7e0001',
      );
    } finally {
      await c.end();
    }
  });

  it('post-migrate index job: creates, keeps, rebuilds an INVALID index and reports readiness (idempotent)', async () => {
    const shadow = (await h.platform.query<{ id: string }>(`SELECT platform_embedding_pin_register('index-job', 1024) AS id`)).rows[0]!.id;
    const name = `embedding_hnsw_${shadow.slice(0, 8)}`;
    const valid = async () =>
      (await h.admin.query<{ v: boolean }>(`SELECT i.indisvalid AS v FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [name])).rows[0]?.v;
    const first = await ensurePinIndex(scratch.adminUrl, shadow);
    expect(first).toMatchObject({ action: 'created', valid: true, index: name });
    expect(await valid()).toBe(true);
    expect((await ensurePinIndex(scratch.adminUrl, shadow)).action).toBe('kept');
    // An interrupted concurrent build leaves an INVALID index; the job drops and rebuilds it.
    await h.admin.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = ('public.' || $1)::regclass`, [name]);
    expect(await valid()).toBe(false);
    expect(await ensurePinIndex(scratch.adminUrl, shadow)).toMatchObject({ action: 'rebuilt', valid: true });
    expect(await valid()).toBe(true);
    // Readiness: coverage is complete only when no chunk hash of a current version lacks a vector.
    const o = await h.seedOrg();
    const { version } = await liveDoc(o, ['readiness text']);
    const hash = (await missing(o, version, shadow))[0]!;
    const before = await reportPinReadiness(scratch.platformUrl, shadow, true);
    expect(before.coverageComplete).toBe(false);
    expect(before.total).toBeGreaterThan(before.covered);
    await upsert(o, hash, shadow, unitVector(400));
    for (const x of (await h.platform.query<{ id: string }>('SELECT platform_orgs() AS id')).rows) {
      for (const hh of (await h.platform.query<{ h: Buffer }>('SELECT platform_embedding_reconcile($1, $2, 1000) AS h', [x.id, shadow])).rows) {
        await h.platform.query('SELECT platform_embedding_upsert($1, $2, $3, $4::vector)', [x.id, hh.h, shadow, unitVector(401)]);
      }
    }
    const after = await reportPinReadiness(scratch.platformUrl, shadow, true);
    expect(after).toMatchObject({ coverageComplete: true, indexValid: true });
    const ready = await h.admin.query<{ index_valid: boolean; coverage_complete: boolean }>('SELECT index_valid, coverage_complete FROM platform.embedding_pin_ready WHERE pin_id = $1', [shadow]);
    expect(ready.rows[0]).toEqual({ index_valid: true, coverage_complete: true });
    // Control: a not-yet-valid index is reported as such and blocks the switch.
    await reportPinReadiness(scratch.platformUrl, shadow, false);
    await expect(h.platform.query('SELECT platform_embedding_pin_switch($1)', [shadow])).rejects.toThrow(/not ready/);
    await h.platform.query('SELECT platform_embedding_pin_retire($1)', [shadow]);
  });

  it('pin switch: refuses an unready, stale or non-shadow target; promotes atomically with one active pin; retire removes vectors and index; a retired pin cannot return', async () => {
    const o = await h.seedOrg();
    const { version } = await liveDoc(o, ['switch text']);
    const hash = (await missing(o, version))[0]!;
    await upsert(o, hash, DEFAULT_PIN, unitVector(200));
    const shadow = (
      await h.platform.query<{ id: string }>(
        `SELECT platform_embedding_pin_register('Qwen3-Embedding-0.6B-v2', 1024) AS id`,
      )
    ).rows[0]!.id;
    await expect(
      h.platform.query('SELECT platform_embedding_pin_register($1, 768)', ['x']),
    ).rejects.toThrow(/dims must be 1024/);
    expect(await upsert(o, hash, shadow, unitVector(201))).toBe(true); // a shadow pin accepts vectors; retrieval stays on the active pin
    const active = async () =>
      (
        await h.platform.query<{ id: string }>('SELECT id FROM platform_embedding_active_pin()')
      ).rows.map((r) => r.id);
    expect(await active()).toEqual([DEFAULT_PIN]);
    await expect(
      h.platform.query('SELECT platform_embedding_pin_switch($1)', [shadow]),
    ).rejects.toThrow(/not ready/);
    await h.platform.query('SELECT platform_embedding_pin_ready($1, false, true)', [shadow]);
    await expect(
      h.platform.query('SELECT platform_embedding_pin_switch($1)', [shadow]),
    ).rejects.toThrow(/not ready/);
    await h.platform.query('SELECT platform_embedding_pin_ready($1, true, false)', [shadow]);
    await expect(
      h.platform.query('SELECT platform_embedding_pin_switch($1)', [shadow]),
    ).rejects.toThrow(/not ready/);
    await h.platform.query('SELECT platform_embedding_pin_ready($1, true, true)', [shadow]);
    await h.admin.query(
      `UPDATE platform.embedding_pin_ready SET checked_at = now() - interval '2 hours' WHERE pin_id = $1`,
      [shadow],
    );
    await expect(
      h.platform.query('SELECT platform_embedding_pin_switch($1)', [shadow]),
    ).rejects.toThrow(/not ready/); // stale readiness
    await h.platform.query('SELECT platform_embedding_pin_ready($1, true, true)', [shadow]);
    await expect(
      h.platform.query('SELECT platform_embedding_pin_switch($1)', [DEFAULT_PIN]),
    ).rejects.toThrow(/must be a shadow pin/);
    await expect(
      h.platform.query('SELECT platform_embedding_pin_retire($1)', [DEFAULT_PIN]),
    ).rejects.toThrow(/only a shadow pin/);
    await h.platform.query('SELECT platform_embedding_pin_switch($1)', [shadow]);
    expect(await active()).toEqual([shadow]);
    const states = await h.admin.query<{ id: string; state: string }>(
      'SELECT id, state FROM platform.embedding_pin',
    );
    expect(states.rows.filter((r) => r.state === 'active')).toHaveLength(1);
    expect(states.rows.find((r) => r.id === DEFAULT_PIN)!.state).toBe('shadow'); // demoted, vectors still present
    expect(await vectorCount(o, DEFAULT_PIN)).toBe(1);
    // After the switch, a literal-pin query on the new pin works and the old pin's vectors are not selected.
    // Retire the old pin: vectors and index go; switching back to it is refused.
    await h.admin.query(
      `CREATE INDEX embedding_hnsw_${shadow.slice(0, 8)} ON embedding USING hnsw (vector vector_cosine_ops) WHERE pin_id = '${shadow}'::uuid`,
    );
    await h.platform.query('SELECT platform_embedding_pin_retire($1)', [DEFAULT_PIN]);
    expect(await vectorCount(o, DEFAULT_PIN)).toBe(0);
    expect(await vectorCount(o, shadow)).toBe(1);
    const idx = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'embedding_hnsw_5a7e0001'`,
    );
    expect(idx.rows[0]!.n).toBe(0);
    await expect(
      h.platform.query('SELECT platform_embedding_pin_switch($1)', [DEFAULT_PIN]),
    ).rejects.toThrow(/must be a shadow pin/);
    await expect(upsert(o, hash, DEFAULT_PIN, unitVector(202))).rejects.toThrow(
      /pin is not active or shadow/,
    );
  });
});

describe.skipIf(!enabled)('embedding GC versus finish (integration)', () => {
  let scratch: Scratch;
  let h: Harness;

  beforeAll(async () => {
    scratch = await createScratchDatabase(adminUrl!, appUrl!, platformUrl!, 'm2a_gc');
    await runMigrations(scratch.adminUrl);
    h = await makeHarness(scratch.adminUrl, scratch.appUrl, scratch.platformUrl);
  });
  afterAll(async () => {
    await h.close();
    await scratch.drop();
  });

  /** An orphan vector for text T (its chunk is gone), then a second document that finishes with the same T. */
  async function setup() {
    const o = await h.seedOrg();
    const text = `racing text ${randomUUID()}`;
    const c1 = await h.createDocument(o);
    const v1 = await h.initVersion(o, c1);
    await h.complete(o, c1, v1);
    await h.finish(o, v1, await h.claim(o, v1), [{ text }]);
    const hash = sha256Nfc(text);
    await h.platform.query('SELECT platform_embedding_upsert($1, $2, $3, $4::vector)', [
      o.orgId,
      hash,
      DEFAULT_PIN,
      unitVector(300),
    ]);
    await h.admin.query('DELETE FROM chunk WHERE org_id = $1 AND content_version_id = $2', [
      o.orgId,
      v1,
    ]);
    const c2 = await h.createDocument(o);
    const v2 = await h.initVersion(o, c2);
    await h.complete(o, c2, v2);
    const a2 = await h.claim(o, v2);
    return { o, text, hash, v2, a2 };
  }
  const vectors = async (o: TestOrg) =>
    (
      await h.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM embedding WHERE org_id = $1',
        [o.orgId],
      )
    ).rows[0]!.n;

  it('gc waits for an in-flight finish and keeps the vector the new chunk references', async () => {
    const { o, text, v2, a2 } = await setup();
    const A = new pg.Client({ connectionString: scratch.platformUrl });
    const B = new pg.Client({ connectionString: scratch.platformUrl });
    await A.connect();
    await B.connect();
    try {
      await A.query('BEGIN');
      await A.query('SELECT platform_document_finish($1, $2, $3, $4::jsonb)', [
        o.orgId,
        v2,
        a2,
        JSON.stringify([{ text }]),
      ]);
      const pid = (await B.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
      const gc = B.query('SELECT platform_embedding_gc($1)', [o.orgId]);
      await waitForLockWait(h.admin, pid);
      await A.query('COMMIT');
      await gc;
    } finally {
      await A.end();
      await B.end();
    }
    expect(await vectors(o)).toBe(1);
    expect(
      (
        await h.platform.query('SELECT platform_embedding_missing_hashes($1, $2, $3)', [
          o.orgId,
          v2,
          DEFAULT_PIN,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('control: an unlocked garbage collection deletes it, and the reconciliation scan finds and repairs the gap', async () => {
    const { o, text, hash, v2, a2 } = await setup();
    const A = new pg.Client({ connectionString: scratch.platformUrl });
    await A.connect();
    try {
      await A.query('BEGIN');
      await A.query('SELECT platform_document_finish($1, $2, $3, $4::jsonb)', [
        o.orgId,
        v2,
        a2,
        JSON.stringify([{ text }]),
      ]);
      // What GC would do without the advisory lock: the uncommitted chunk is invisible to it.
      await h.admin.query(
        'DELETE FROM embedding e WHERE e.org_id = $1 AND NOT EXISTS (SELECT 1 FROM chunk k WHERE k.org_id = e.org_id AND k.text_sha256 = e.text_sha256)',
        [o.orgId],
      );
      await A.query('COMMIT');
    } finally {
      await A.end();
    }
    expect(
      await vectors(o),
      'the unlocked gc removed the vector a committed chunk references',
    ).toBe(0);
    const scan = await h.platform.query<{ h: Buffer }>(
      'SELECT platform_embedding_reconcile($1, $2, 100) AS h',
      [o.orgId, DEFAULT_PIN],
    );
    expect(scan.rows.map((r) => r.h.toString('hex'))).toEqual([hash.toString('hex')]);
    await h.platform.query('SELECT platform_embedding_upsert($1, $2, $3, $4::vector)', [
      o.orgId,
      hash,
      DEFAULT_PIN,
      unitVector(301),
    ]);
    expect(
      (
        await h.platform.query('SELECT platform_embedding_reconcile($1, $2, 100)', [
          o.orgId,
          DEFAULT_PIN,
        ])
      ).rowCount,
    ).toBe(0);
  });
});
