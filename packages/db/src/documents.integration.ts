// SPDX-License-Identifier: AGPL-3.0-only
// M2a core: the document version lifecycle in the database (claim, step, fail, finish, upload complete,
// retract, replace), the 0009 repair, the 0004 repair, the chunk trigger, announcement and the publish
// guard. Spec: NEG-2 races (a)-(e), AC-2 parse-then-current, AC-1 states. Every behaviour test carries a
// failing control (an unguarded variant, or the unrepaired earlier function body) where it matters.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrationsDir, runMigrations } from './migrate.js';
import {
  makeHarness,
  sampleChunks,
  sha256Nfc,
  waitForLockWait,
  type Harness,
  type TestOrg,
} from './test-support.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const appUrl = process.env['DATABASE_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL'];
const SEED = 20261104; // fixed seed for the iteration counts below

/** Body of a function as defined in one migration file (for broken-variant controls). */
function functionFromMigration(file: string, name: string): string {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  const re = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;`);
  const m = re.exec(sql);
  if (!m) throw new Error(`${name} not found in ${file}`);
  return m[0];
}

describe.skipIf(!adminUrl || !appUrl || !platformUrl)('document lifecycle (integration)', () => {
  let h: Harness;
  let org: TestOrg;

  beforeAll(async () => {
    await runMigrations(adminUrl!);
    h = await makeHarness(adminUrl!, appUrl!, platformUrl!);
    org = await h.seedOrg();
  });
  afterAll(async () => {
    await h.close();
  });

  /** A document with one completed upload (seq assigned, status uploaded, step uploaded). */
  async function uploaded(o: TestOrg = org): Promise<{ content: string; version: string }> {
    const content = await h.createDocument(o);
    const version = await h.initVersion(o, content);
    await h.complete(o, content, version);
    return { content, version };
  }

  async function statuses(o: TestOrg, content: string): Promise<Record<string, number>> {
    const r = await h.admin.query<{ status: string; n: number }>(
      'SELECT status::text, count(*)::int AS n FROM content_version WHERE org_id = $1 AND content_id = $2 GROUP BY status',
      [o.orgId, content],
    );
    return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
  }

  describe('happy path and chunk shape (AC-2)', () => {
    it('upload complete assigns completed_seq; claim, finish make the version current with ordinal and hash chunks', async () => {
      const { content, version } = await uploaded();
      const v0 = await h.version(org, version);
      expect(v0).toMatchObject({
        status: 'uploaded',
        processing_step: 'uploaded',
        completed_seq: '1',
      });
      const attempt = await h.claim(org, version);
      expect(attempt).toMatch(/^[0-9a-f-]{36}$/);
      expect(await h.version(org, version)).toMatchObject({
        status: 'processing',
        parse_attempt: attempt,
      });
      const chunks = sampleChunks(3);
      expect(await h.finish(org, version, attempt, chunks)).toBe('ok');
      expect(await h.version(org, version)).toMatchObject({
        status: 'current',
        processing_step: 'done',
        parse_attempt: null,
      });
      expect(await h.currentVersionId(org, content)).toBe(version);
      const rows = await h.admin.query<{
        ordinal: number;
        text: string;
        text_sha256: Buffer;
        locator: { page: number };
      }>(
        'SELECT ordinal, text, text_sha256, locator FROM chunk WHERE org_id = $1 AND content_version_id = $2 ORDER BY ordinal',
        [org.orgId, version],
      );
      expect(rows.rows.map((r) => r.ordinal)).toEqual([1, 2, 3]);
      expect(rows.rows.map((r) => r.locator.page)).toEqual([1, 2, 3]);
      for (const r of rows.rows) expect(r.text_sha256.equals(sha256Nfc(r.text))).toBe(true);
    });

    it('parse-then-current keeps the chunks (count > 0) and a second run changes nothing; the unrepaired 0009 function deletes them', async () => {
      const { version } = await uploaded();
      const attempt = await h.claim(org, version);
      await h.finish(org, version, attempt, sampleChunks(4, 'beta'));
      const n = await h.chunkCount(org, version);
      expect(n).toBe(4);
      // A second run: reindex (skips documents), a transcript update, and a no-op status touch.
      await h.platform.query('SELECT platform_search_reindex($1)', [org.orgId]);
      await h.admin.query(
        `UPDATE content_version SET transcript = '{"segments":[]}'::jsonb WHERE org_id = $1 AND id = $2`,
        [org.orgId, version],
      );
      await h.admin.query(
        `UPDATE content_version SET status = 'current' WHERE org_id = $1 AND id = $2`,
        [org.orgId, version],
      );
      expect(await h.chunkCount(org, version)).toBe(n);

      // Broken variant: the 0009 body restored in a rolled-back transaction deletes the chunks.
      const old = functionFromMigration('0009_m1b_search.sql', 'search_index_version');
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(old);
        await c.query(
          `UPDATE content_version SET transcript = '{"segments":[],"second":1}'::jsonb WHERE org_id = $1 AND id = $2`,
          [org.orgId, version],
        );
        const after = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM chunk WHERE org_id = $1 AND content_version_id = $2',
          [org.orgId, version],
        );
        expect(after.rows[0]!.n, 'the unrepaired function must delete the document chunks').toBe(0);
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
      expect(await h.chunkCount(org, version)).toBe(n);
    });

    it('platform_search_prune removes chunks of a superseded version but never of the live one', async () => {
      const content = await h.createDocument(org);
      const v1 = await h.initVersion(org, content);
      await h.complete(org, content, v1);
      await h.finish(org, v1, await h.claim(org, v1), sampleChunks(2, 'one'));
      const v2 = await h.initVersion(org, content);
      await h.complete(org, content, v2);
      await h.finish(org, v2, await h.claim(org, v2), sampleChunks(3, 'two'));
      expect(await h.version(org, v1)).toMatchObject({ status: 'superseded' });
      const r = await h.platform.query<{ n: number }>('SELECT platform_search_prune($1) AS n', [
        org.orgId,
      ]);
      expect(r.rows[0]!.n).toBeGreaterThanOrEqual(2);
      expect(await h.chunkCount(org, v1)).toBe(0);
      expect(await h.chunkCount(org, v2)).toBe(3);
    });

    it('finish refuses no text and oversize chunks with a failed version', async () => {
      for (const [chunks, reason] of [
        [[], 'no_text'],
        [[{ text: '   ' }], 'no_text'],
        [[{ locator: {} }], 'no_text'],
        [[{ text: 'x'.repeat(8001) }], 'chunk_limit'],
      ] as const) {
        const { version } = await uploaded();
        const attempt = await h.claim(org, version);
        expect(await h.finish(org, version, attempt, chunks)).toBe('failed');
        expect(await h.version(org, version)).toMatchObject({
          status: 'failed',
          processing_error: reason,
        });
        expect(await h.chunkCount(org, version)).toBe(0);
      }
    });
  });

  describe('claim, step and fail', () => {
    it('a retried claim replaces the attempt (a dead worker is fenced) and the job still completes', async () => {
      const { content, version } = await uploaded();
      const a1 = await h.claim(org, version);
      const a2 = await h.claim(org, version); // pg-boss retry after a worker crash
      expect(a2).not.toBe(a1);
      const stale = await h.platform.query<{ r: string }>(
        'SELECT platform_document_step($1, $2, $3, $4, NULL) AS r',
        [org.orgId, version, a1, 'parse'],
      );
      expect(stale.rows[0]!.r).toBe('stale');
      const ok = await h.platform.query<{ r: string }>(
        'SELECT platform_document_step($1, $2, $3, $4, NULL) AS r',
        [org.orgId, version, a2, 'parse'],
      );
      expect(ok.rows[0]!.r).toBe('ok');
      expect(await h.finish(org, version, a1, sampleChunks(1))).toBe('stale');
      expect(await h.chunkCount(org, version)).toBe(0);
      expect(await h.finish(org, version, a2, sampleChunks(2))).toBe('ok');
      expect(await h.currentVersionId(org, content)).toBe(version);
    });

    it('a refused claim returns NULL: awaiting upload, current, failed, retracted, unknown version, a clip version', async () => {
      const content = await h.createDocument(org);
      const awaiting = await h.initVersion(org, content);
      expect(await h.claim(org, awaiting)).toBeNull();
      const done = await uploaded();
      await h.finish(org, done.version, await h.claim(org, done.version), sampleChunks(1));
      expect(await h.claim(org, done.version)).toBeNull(); // current
      const bad = await uploaded();
      await h.platform.query('SELECT platform_document_fail($1, $2, $3)', [
        org.orgId,
        bad.version,
        'x',
      ]);
      expect(await h.claim(org, bad.version)).toBeNull(); // failed
      const gone = await uploaded();
      await h.retract(org, gone.content);
      expect(await h.claim(org, gone.version)).toBeNull(); // retracted
      expect(await h.claim(org, '00000000-0000-4000-8000-000000000099')).toBeNull();
      const clip = await h.createClip(org);
      const cv = await h.initVersion(org, clip);
      await h.admin.query(
        `UPDATE content_version SET processing_step = 'uploaded' WHERE org_id = $1 AND id = $2`,
        [org.orgId, cv],
      );
      expect(await h.claim(org, cv)).toBeNull(); // not a document
    });

    it('platform_document_fail: unclaimed uploaded or processing versions fail; awaiting_upload and current never do; failed is terminal for steps', async () => {
      const a = await uploaded();
      const f1 = await h.platform.query<{ r: boolean }>(
        'SELECT platform_document_fail($1, $2, $3) AS r',
        [org.orgId, a.version, 'attestation_unavailable'],
      );
      expect(f1.rows[0]!.r).toBe(true);
      expect(await h.version(org, a.version)).toMatchObject({
        status: 'failed',
        processing_error: 'attestation_unavailable',
        parse_attempt: null,
      });
      const again = await h.platform.query<{ r: boolean }>(
        'SELECT platform_document_fail($1, $2, $3) AS r',
        [org.orgId, a.version, 'again'],
      );
      expect(again.rows[0]!.r).toBe(false);

      const content = await h.createDocument(org);
      const awaiting = await h.initVersion(org, content);
      const f2 = await h.platform.query<{ r: boolean }>(
        'SELECT platform_document_fail($1, $2, $3) AS r',
        [org.orgId, awaiting, 'x'],
      );
      expect(f2.rows[0]!.r).toBe(false);
      expect(await h.version(org, awaiting)).toMatchObject({
        status: 'uploaded',
        processing_step: 'awaiting_upload',
      });

      const p = await uploaded();
      const attempt = await h.claim(org, p.version);
      const f3 = await h.platform.query<{ r: boolean }>(
        'SELECT platform_document_fail($1, $2, $3) AS r',
        [org.orgId, p.version, 'reaped'],
      );
      expect(f3.rows[0]!.r).toBe(true); // a stuck processing version can be reaped
      const step = await h.platform.query<{ r: string }>(
        'SELECT platform_document_step($1, $2, $3, $4, NULL) AS r',
        [org.orgId, p.version, attempt, 'parse'],
      );
      expect(step.rows[0]!.r).toBe('stale'); // after failed no step write is accepted
      expect(await h.finish(org, p.version, attempt, sampleChunks(1))).toBe('stale');

      const cur = await uploaded();
      await h.finish(org, cur.version, await h.claim(org, cur.version), sampleChunks(1));
      const f4 = await h.platform.query<{ r: boolean }>(
        'SELECT platform_document_fail($1, $2, $3) AS r',
        [org.orgId, cur.version, 'x'],
      );
      expect(f4.rows[0]!.r).toBe(false);
      expect(await h.version(org, cur.version)).toMatchObject({ status: 'current' });
    });

    it('platform_document_step: a NULL attempt is always stale; an error marks the version failed; terminal versions are stale', async () => {
      const { version } = await uploaded();
      const attempt = await h.claim(org, version);
      const nul = await h.platform.query<{ r: string }>(
        'SELECT platform_document_step($1, $2, NULL, $3, NULL) AS r',
        [org.orgId, version, 'parse'],
      );
      expect(nul.rows[0]!.r).toBe('stale');
      const err = await h.platform.query<{ r: string }>(
        'SELECT platform_document_step($1, $2, $3, $4, $5) AS r',
        [org.orgId, version, attempt, 'parse', 'password_protected'],
      );
      expect(err.rows[0]!.r).toBe('ok');
      expect(await h.version(org, version)).toMatchObject({
        status: 'failed',
        processing_error: 'password_protected',
        processing_step: 'parse',
      });
      const after = await h.platform.query<{ r: string }>(
        'SELECT platform_document_step($1, $2, $3, $4, NULL) AS r',
        [org.orgId, version, attempt, 'x'],
      );
      expect(after.rows[0]!.r).toBe('stale');
    });

    it('every function refuses a missing org', async () => {
      for (const sql of [
        'SELECT platform_document_claim(NULL, gen_random_uuid())',
        'SELECT platform_document_step(NULL, gen_random_uuid(), gen_random_uuid(), NULL, NULL)',
        'SELECT platform_document_fail(NULL, gen_random_uuid(), NULL)',
        `SELECT platform_document_finish(NULL, gen_random_uuid(), gen_random_uuid(), '[]'::jsonb)`,
        'SELECT platform_content_kind(NULL, gen_random_uuid())',
      ]) {
        await expect(h.platform.query(sql), sql).rejects.toThrow(/org required/);
      }
    });
  });

  describe('NEG-2 races', () => {
    it('(a) v1 slow, replace to v2 finishes first, then v1 finishes: v2 stays current and v1 never flips it (control: the unguarded write flips it)', async () => {
      const content = await h.createDocument(org);
      const v1 = await h.initVersion(org, content);
      await h.complete(org, content, v1);
      const a1 = await h.claim(org, v1);
      const v2 = await h.initVersion(org, content);
      await h.complete(org, content, v2); // rotates v1: parse_attempt NULL, failed superseded
      expect(await h.version(org, v1)).toMatchObject({
        status: 'failed',
        processing_error: 'superseded',
        parse_attempt: null,
      });
      const a2 = await h.claim(org, v2);
      expect(await h.finish(org, v2, a2, sampleChunks(2, 'new'))).toBe('ok');
      expect(await h.finish(org, v1, a1, sampleChunks(5, 'old'))).toBe('stale');
      expect(await h.currentVersionId(org, content)).toBe(v2);
      expect(await h.version(org, v2)).toMatchObject({ status: 'current' });
      expect(await h.chunkCount(org, v1)).toBe(0);
      expect(await statuses(org, content)).toEqual({ current: 1, failed: 1 });

      // Control: an unguarded finish (what a worker writing the status directly would do) flips it back.
      const ctl = await h.createDocument(org);
      const c1 = await h.initVersion(org, ctl);
      await h.complete(org, ctl, c1);
      const c2 = await h.initVersion(org, ctl);
      await h.complete(org, ctl, c2);
      await h.finish(org, c2, await h.claim(org, c2), sampleChunks(1));
      await h.admin.query(
        `UPDATE content_version SET status = 'current' WHERE org_id = $1 AND id = $2`,
        [org.orgId, c1],
      );
      await h.admin.query(
        `UPDATE content SET current_version_id = $3 WHERE org_id = $1 AND id = $2`,
        [org.orgId, ctl, c1],
      );
      expect(
        await h.currentVersionId(org, ctl),
        'the unguarded write must be able to flip the version',
      ).toBe(c1);
    });

    it('(b) retract, then the worker finishes: the version stays retracted and zero chunks exist (control: finish before retract serves)', async () => {
      const { content, version } = await uploaded();
      const attempt = await h.claim(org, version);
      await h.retract(org, content);
      expect(await h.version(org, version)).toMatchObject({
        status: 'retracted',
        parse_attempt: null,
      });
      expect(await h.finish(org, version, attempt, sampleChunks(3))).toBe('stale');
      expect(await h.version(org, version)).toMatchObject({ status: 'retracted' });
      expect(await h.chunkCount(org, version)).toBe(0);
      expect(await h.currentVersionId(org, content)).toBeNull();
      // Control: the other order really does produce a current version first (so the zero above is the guard).
      const ctl = await uploaded();
      expect(
        await h.finish(org, ctl.version, await h.claim(org, ctl.version), sampleChunks(3)),
      ).toBe('ok');
      expect(await h.chunkCount(org, ctl.version)).toBe(3);
    });

    it('(c) an abandoned replace init rotates nothing: the first version still finishes', async () => {
      const content = await h.createDocument(org);
      const v1 = await h.initVersion(org, content);
      await h.complete(org, content, v1);
      const a1 = await h.claim(org, v1);
      const v2 = await h.initVersion(org, content); // init only, never completed
      expect(await h.version(org, v1)).toMatchObject({ status: 'processing', parse_attempt: a1 });
      expect(await h.finish(org, v1, a1, sampleChunks(2))).toBe('ok');
      expect(await h.version(org, v2)).toMatchObject({
        status: 'uploaded',
        processing_step: 'awaiting_upload',
      });
      expect(await statuses(org, content)).toEqual({ current: 1, uploaded: 1 });
    });

    it('(d) replace init during first-version processing: exactly one current and none left processing, either finish order', async () => {
      // d1: the replacement completes while v1 is processing; v1 is rotated and fails superseded.
      const c1 = await h.createDocument(org);
      const a = await h.initVersion(org, c1);
      await h.complete(org, c1, a);
      const aAttempt = await h.claim(org, a);
      const b = await h.initVersion(org, c1);
      await h.complete(org, c1, b);
      expect(await h.finish(org, a, aAttempt, sampleChunks(1))).toBe('stale');
      expect(await h.finish(org, b, await h.claim(org, b), sampleChunks(2))).toBe('ok');
      expect(await statuses(org, c1)).toEqual({ current: 1, failed: 1 });
      // d2: v1 finishes before the replacement completes; the replacement later supersedes it.
      const c2 = await h.createDocument(org);
      const a2 = await h.initVersion(org, c2);
      await h.complete(org, c2, a2);
      const a2Attempt = await h.claim(org, a2);
      const b2 = await h.initVersion(org, c2);
      expect(await h.finish(org, a2, a2Attempt, sampleChunks(1))).toBe('ok');
      await h.complete(org, c2, b2);
      expect(await h.finish(org, b2, await h.claim(org, b2), sampleChunks(2))).toBe('ok');
      expect(await statuses(org, c2)).toEqual({ current: 1, superseded: 1 });
      expect(await h.currentVersionId(org, c2)).toBe(b2);
    });

    it('(e) two inits with out-of-order completes: the later complete wins, one current, none processing', async () => {
      const content = await h.createDocument(org);
      const v1 = await h.initVersion(org, content);
      const v2 = await h.initVersion(org, content);
      expect(await h.complete(org, content, v2)).toBe(1);
      const a2 = await h.claim(org, v2);
      expect(await h.complete(org, content, v1)).toBe(2); // v1 completes last: newest
      expect(await h.version(org, v2)).toMatchObject({
        status: 'failed',
        processing_error: 'superseded',
      });
      expect(await h.finish(org, v2, a2, sampleChunks(1))).toBe('stale');
      expect(await h.claim(org, v2)).toBeNull();
      expect(await h.finish(org, v1, await h.claim(org, v1), sampleChunks(2))).toBe('ok');
      expect(await statuses(org, content)).toEqual({ current: 1, failed: 1 });
      expect(await h.currentVersionId(org, content)).toBe(v1);
    });

    it('a stale finisher that lost to a later complete marks its own version failed (superseded) when it was never rotated', async () => {
      // Out-of-band: a later complete exists but v1 still holds its attempt (rotation skipped by an old build).
      const content = await h.createDocument(org);
      const v1 = await h.initVersion(org, content);
      await h.complete(org, content, v1);
      const a1 = await h.claim(org, v1);
      const v2 = await h.initVersion(org, content);
      await h.admin.query(
        `UPDATE content_version SET processing_step = 'uploaded', completed_seq = 2 WHERE org_id = $1 AND id = $2`,
        [org.orgId, v2],
      );
      expect(await h.finish(org, v1, a1, sampleChunks(1))).toBe('stale');
      expect(await h.version(org, v1)).toMatchObject({
        status: 'failed',
        processing_error: 'superseded',
      });
      expect(await h.chunkCount(org, v1)).toBe(0);
    });

    it('concurrent completes of two versions of one content serialise on the content lock with distinct sequence numbers', async () => {
      const content = await h.createDocument(org);
      const v1 = await h.initVersion(org, content);
      const v2 = await h.initVersion(org, content);
      const mk = async () => {
        const c = new pg.Client({ connectionString: appUrl });
        await c.connect();
        await c.query('BEGIN');
        await c.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
          [org.orgId, org.contributor],
        );
        const pid = (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
        return { c, pid };
      };
      const A = await mk();
      const B = await mk();
      try {
        const ra = await A.c.query<{ s: string }>(
          'SELECT document_upload_complete($1, $2)::text AS s',
          [content, v1],
        );
        const pb = B.c.query<{ s: string }>('SELECT document_upload_complete($1, $2)::text AS s', [
          content,
          v2,
        ]);
        await waitForLockWait(h.admin, B.pid);
        await A.c.query('COMMIT');
        const rb = await pb;
        await B.c.query('COMMIT');
        expect(ra.rows[0]!.s).toBe('1');
        expect(rb.rows[0]!.s).toBe('2');
      } finally {
        await A.c.end();
        await B.c.end();
      }
      expect(await h.version(org, v1)).toMatchObject({
        status: 'failed',
        processing_error: 'superseded',
      });
      expect(await h.version(org, v2)).toMatchObject({
        status: 'uploaded',
        processing_step: 'uploaded',
      });
    });

    it('a second complete for an already completed version is refused (the API maps it to the idempotent 409)', async () => {
      const { content, version } = await uploaded();
      await expect(h.complete(org, content, version)).rejects.toThrow(/not awaiting upload/);
    });

    it('finish holds the content lock: a concurrent retract waits and the result is a retracted version that is not reader-visible', async () => {
      const { content, version } = await uploaded();
      await h.publish(org, content);
      const attempt = await h.claim(org, version);
      const A = new pg.Client({ connectionString: platformUrl });
      const B = new pg.Client({ connectionString: appUrl });
      await A.connect();
      await B.connect();
      try {
        await A.query('BEGIN');
        const fr = await A.query<{ r: string }>(
          'SELECT platform_document_finish($1, $2, $3, $4::jsonb) AS r',
          [org.orgId, version, attempt, JSON.stringify(sampleChunks(2))],
        );
        expect(fr.rows[0]!.r).toBe('ok');
        await B.query('BEGIN');
        await B.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
          [org.orgId, org.contributor],
        );
        const pid = (await B.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
        const pb = B.query('SELECT content_retract($1)', [content]);
        await waitForLockWait(h.admin, pid);
        await A.query('COMMIT');
        await pb;
        await B.query('COMMIT');
      } finally {
        await A.end();
        await B.end();
      }
      expect(await h.version(org, version)).toMatchObject({ status: 'retracted' });
      const visible = await h.admin.query(
        `SELECT 1 FROM content c WHERE c.org_id = $1 AND c.id = $2 AND c.state = 'published'`,
        [org.orgId, content],
      );
      expect(visible.rowCount).toBe(0);
    });

    it('retract holds the content lock: a concurrent finish waits, then returns stale and writes zero chunks', async () => {
      const { content, version } = await uploaded();
      const attempt = await h.claim(org, version);
      const A = new pg.Client({ connectionString: appUrl });
      const B = new pg.Client({ connectionString: platformUrl });
      await A.connect();
      await B.connect();
      try {
        await A.query('BEGIN');
        await A.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
          [org.orgId, org.contributor],
        );
        await A.query('SELECT content_retract($1)', [content]);
        const pid = (await B.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
        const pb = B.query<{ r: string }>(
          'SELECT platform_document_finish($1, $2, $3, $4::jsonb) AS r',
          [org.orgId, version, attempt, JSON.stringify(sampleChunks(2))],
        );
        await waitForLockWait(h.admin, pid);
        await A.query('COMMIT');
        expect((await pb).rows[0]!.r).toBe('stale');
      } finally {
        await A.end();
        await B.end();
      }
      expect(await h.chunkCount(org, version)).toBe(0);
      expect(await h.version(org, version)).toMatchObject({ status: 'retracted' });
    });

    it(`finish, replace-complete and retract interleavings never deadlock and end with at most one current version (seed ${SEED})`, async () => {
      // A small deterministic generator picks the pair of racing operations per round.
      let s = SEED;
      const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let round = 0; round < 12; round += 1) {
        const content = await h.createDocument(org);
        const v1 = await h.initVersion(org, content);
        await h.complete(org, content, v1);
        const a1 = await h.claim(org, v1);
        const v2 = await h.initVersion(org, content);
        const ops: Array<() => Promise<unknown>> = [
          () => h.finish(org, v1, a1, sampleChunks(2)),
          () => h.complete(org, content, v2),
          ...(rnd() < 0.5 ? [() => h.retract(org, content)] : []),
        ];
        const order = ops.map((o, i) => [rnd(), o, i] as const).sort((x, y) => x[0] - y[0]);
        const settled = await Promise.allSettled(order.map(([, o]) => o()));
        for (const r of settled) {
          // Only a lost race (retracted first) is acceptable; a deadlock or any other error fails the round.
          if (r.status === 'rejected')
            expect(String((r.reason as Error).message), `seed ${SEED} round ${round}`).toMatch(
              /content not found or retracted|not awaiting upload/,
            );
        }
        const st = await statuses(org, content);
        expect(st['current'] ?? 0, `seed ${SEED} round ${round}`).toBeLessThanOrEqual(1);
        expect(st['processing'] ?? 0, `seed ${SEED} round ${round}`).toBe(0);
      }
    });
  });

  describe('announcement (migration 0004 replicated) and the publish guard', () => {
    it('publish while processing, then finish: exactly one content.published; a replace behaves as for a clip', async () => {
      const { content, version } = await uploaded();
      await h.publish(org, content);
      expect(await h.events(org, content, 'content.published')).toHaveLength(0); // nothing to announce yet
      const attempt = await h.claim(org, version);
      expect(await h.finish(org, version, attempt, sampleChunks(1))).toBe('ok');
      expect(await h.finish(org, version, attempt, sampleChunks(1))).toBe('stale'); // a repeat adds nothing
      const ev = await h.events(org, content, 'content.published');
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({
        version_id: version,
        payload: { source: 'processing_complete' },
      });
      // Replace: a second version announces once for itself.
      const v2 = await h.initVersion(org, content);
      await h.complete(org, content, v2);
      await h.finish(org, v2, await h.claim(org, v2), sampleChunks(1));
      const ev2 = await h.events(org, content, 'content.published');
      expect(ev2.map((e) => e.version_id)).toEqual([version, v2]);
    });

    it('no announcement for an unpublished, scheduled or expired document, or with the flag off', async () => {
      const draft = await uploaded();
      await h.finish(org, draft.version, await h.claim(org, draft.version), sampleChunks(1));
      expect(await h.events(org, draft.content, 'content.published')).toHaveLength(0);
      const future = await uploaded();
      await h.publish(org, future.content, new Date(Date.now() + 3_600_000));
      await h.finish(org, future.version, await h.claim(org, future.version), sampleChunks(1));
      expect(await h.events(org, future.content, 'content.published')).toHaveLength(0);

      const off = await h.seedOrg({ documentsEnabled: true });
      const d = await uploaded(off);
      await h.publish(off, d.content);
      await h.admin.query(
        `UPDATE org SET settings = settings || '{"documents_enabled": false}' WHERE id = $1`,
        [off.orgId],
      );
      await h.finish(off, d.version, await h.claim(off, d.version), sampleChunks(1));
      expect(await h.events(off, d.content, 'content.published')).toHaveLength(0);
    });

    it('content_publish refuses draft-to-published for a document while the flag is off, allows re-publish, leaves clips alone and keeps millisecond truncation', async () => {
      const off = await h.seedOrg({ documentsEnabled: false });
      const draft = await h.createDocument(off);
      await expect(h.publish(off, draft)).rejects.toThrow(/feature_disabled/);
      const state = await h.admin.query<{ state: string }>(
        'SELECT state::text FROM content WHERE org_id = $1 AND id = $2',
        [off.orgId, draft],
      );
      expect(state.rows[0]!.state).toBe('draft');
      // An org with no key behaves as off.
      const none = await h.seedOrg({ documentsEnabled: null });
      await expect(h.publish(none, await h.createDocument(none))).rejects.toThrow(
        /feature_disabled/,
      );
      // Re-publishing an already published document stays allowed with the flag off.
      const on = await h.seedOrg({ documentsEnabled: true });
      const doc = await h.createDocument(on);
      await h.publish(on, doc);
      await h.admin.query(
        `UPDATE org SET settings = settings || '{"documents_enabled": false}' WHERE id = $1`,
        [on.orgId],
      );
      const t = new Date(Date.now() + 7_200_000);
      await h.publish(on, doc, t, new Date(t.getTime() + 86_400_000));
      // A clip publishes with the flag off.
      await h.publish(off, await h.createClip(off));
      // Millisecond truncation (migration 0011) survives: microseconds are dropped.
      const clip = await h.createClip(on);
      await h.publish(on, clip); // publish_at defaults to now(), which carries microseconds
      const pa = await h.admin.query<{ us: number }>(
        `SELECT (extract(microseconds FROM publish_at))::int % 1000 AS us FROM content WHERE org_id = $1 AND id = $2`,
        [on.orgId, clip],
      );
      expect(pa.rows[0]!.us).toBe(0);
      // Retracted content is still refused with the retracted message.
      const dead = await h.createDocument(on);
      await h.retract(on, dead);
      await expect(h.publish(on, dead)).rejects.toThrow(/content not found or retracted/);
    });
  });

  describe('platform_version_update (old-build safety, 0004 repair)', () => {
    async function viaOldWorker(
      version: string,
      status: string | null,
      error: string | null = null,
    ) {
      await h.platform.query(
        'SELECT platform_version_update($1, $2, $3::version_status, $4, $5, NULL, NULL, NULL)',
        [org.orgId, version, status, status === 'processing' ? 'probe' : 'x', error],
      );
    }

    it('for documents it accepts only a failure write: current and processing are silent no-ops', async () => {
      const { content, version } = await uploaded();
      await h.publish(org, content);
      await viaOldWorker(version, 'processing');
      await viaOldWorker(version, 'current');
      expect(await h.version(org, version)).toMatchObject({
        status: 'uploaded',
        processing_step: 'uploaded',
      });
      expect(await h.currentVersionId(org, content)).toBeNull();
      expect(await h.events(org, content, 'content.published')).toHaveLength(0);
      await viaOldWorker(version, 'failed', 'ffprobe failed');
      expect(await h.version(org, version)).toMatchObject({
        status: 'failed',
        processing_error: 'ffprobe failed',
      });
    });

    it('a failure write cannot flip a current or retracted document version', async () => {
      const { content, version } = await uploaded();
      await h.finish(org, version, await h.claim(org, version), sampleChunks(1));
      await viaOldWorker(version, 'failed', 'late');
      expect(await h.version(org, version)).toMatchObject({
        status: 'current',
        processing_error: null,
      });
      await h.retract(org, content);
      await viaOldWorker(version, 'failed', 'late');
      expect(await h.version(org, version)).toMatchObject({ status: 'retracted' });
    });

    it('control: the unrepaired 0004 function lets an old worker flip a document version to current', async () => {
      const { content, version } = await uploaded();
      const old = functionFromMigration('0004_m1a_review_fixes.sql', 'platform_version_update');
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(old);
        await c.query(
          `SELECT platform_version_update($1, $2, 'current', 'done', NULL, NULL, NULL, NULL)`,
          [org.orgId, version],
        );
        const r = await c.query<{ v: string | null }>(
          'SELECT current_version_id AS v FROM content WHERE org_id = $1 AND id = $2',
          [org.orgId, content],
        );
        expect(r.rows[0]!.v, 'the old body must flip it').toBe(version);
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
      expect(await h.currentVersionId(org, content)).toBeNull();
    });

    it('clip behaviour is unchanged: current switch, supersede and announcement', async () => {
      const clip = await h.createClip(org);
      const v1 = await h.initVersion(org, clip);
      await h.admin.query(
        `UPDATE content_version SET processing_step = 'uploaded' WHERE org_id = $1 AND id = $2`,
        [org.orgId, v1],
      );
      await h.publish(org, clip);
      await viaOldWorker(v1, 'current');
      expect(await h.version(org, v1)).toMatchObject({ status: 'current' });
      expect(await h.currentVersionId(org, clip)).toBe(v1);
      expect(await h.events(org, clip, 'content.published')).toHaveLength(1);
    });

    it('platform_content_kind routes by kind (document versus clip) and returns NULL for unknown content', async () => {
      const doc = await h.createDocument(org);
      const clip = await h.createClip(org);
      const kind = async (id: string) =>
        (
          await h.platform.query<{ k: string | null }>(
            'SELECT platform_content_kind($1, $2) AS k',
            [org.orgId, id],
          )
        ).rows[0]!.k;
      expect(await kind(doc)).toBe('document');
      expect(await kind(clip)).toBe('clip');
      expect(await kind('00000000-0000-4000-8000-000000000099')).toBeNull();
    });
  });

  describe('0009 repair for clips and the chunk trigger', () => {
    const transcript = {
      language: 'en',
      segments: [
        { start_ms: 0, end_ms: 4000, text: 'hello and welcome' },
        { start_ms: 4000, end_ms: 9000, text: 'to the onboarding session' },
        { start_ms: 30000, end_ms: 34000, text: 'security policy follows' },
      ],
    };

    it('a clip transcript index writes ordinals 1..n and the real hash; a reindex keeps the shape; documents are skipped', async () => {
      const clip = await h.createClip(org);
      const v = await h.initVersion(org, clip);
      await h.admin.query(
        `UPDATE content_version SET transcript = $3::jsonb, status = 'current', processing_step = 'done' WHERE org_id = $1 AND id = $2`,
        [org.orgId, v, JSON.stringify(transcript)],
      );
      const rows = await h.admin.query<{ ordinal: number; text: string; text_sha256: Buffer }>(
        'SELECT ordinal, text, text_sha256 FROM chunk WHERE org_id = $1 AND content_version_id = $2 ORDER BY ordinal',
        [org.orgId, v],
      );
      expect(rows.rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.rows.map((r) => r.ordinal)).toEqual(rows.rows.map((_, i) => i + 1));
      for (const r of rows.rows) expect(r.text_sha256.equals(sha256Nfc(r.text))).toBe(true);
      const n = rows.rows.length;
      await h.platform.query('SELECT platform_search_reindex($1)', [org.orgId]);
      expect(await h.chunkCount(org, v)).toBe(n);
      const doc = await uploaded();
      await h.finish(org, doc.version, await h.claim(org, doc.version), sampleChunks(3));
      const re = await h.platform.query<{ n: number }>('SELECT platform_search_reindex($1) AS n', [
        org.orgId,
      ]);
      expect(re.rows[0]!.n).toBeGreaterThanOrEqual(n); // only clips counted
      expect(await h.chunkCount(org, doc.version)).toBe(3);
    });

    it('the trigger assigns max+1 when the ordinal is NULL, computes the NFC hash and recomputes it when the text changes', async () => {
      const { content, version } = await uploaded();
      const ins = async (text: string, ordinal: number | null = null) =>
        (
          await h.admin.query<{ id: string; ordinal: number; text_sha256: Buffer }>(
            `INSERT INTO chunk (org_id, content_version_id, content_id, text, ordinal) VALUES ($1, $2, $3, $4, $5) RETURNING id, ordinal, text_sha256`,
            [org.orgId, version, content, text, ordinal],
          )
        ).rows[0]!;
      const a = await ins('first');
      const b = await ins('second');
      expect([a.ordinal, b.ordinal]).toEqual([1, 2]);
      expect((await ins('explicit', 10)).ordinal).toBe(10);
      expect((await ins('after explicit')).ordinal).toBe(11);
      // NFC versus NFD give one hash; astral code points and a lone-surrogate-free emoji match Node's UTF-8 digest.
      const nfc = await ins('café');
      const nfd = await ins('café');
      expect(nfc.text_sha256.equals(nfd.text_sha256)).toBe(true);
      expect(nfc.text_sha256.equals(sha256Nfc('café'))).toBe(true);
      const astral = await ins('rocket \u{1F680} and \u{20BB7}');
      expect(astral.text_sha256.equals(sha256Nfc('rocket \u{1F680} and \u{20BB7}'))).toBe(true);
      await h.admin.query('UPDATE chunk SET text = $3 WHERE org_id = $1 AND id = $2', [
        org.orgId,
        a.id,
        'changed',
      ]);
      const upd = await h.admin.query<{ text_sha256: Buffer }>(
        'SELECT text_sha256 FROM chunk WHERE org_id = $1 AND id = $2',
        [org.orgId, a.id],
      );
      expect(upd.rows[0]!.text_sha256.equals(sha256Nfc('changed'))).toBe(true);
      // Unique (org, version, ordinal): a duplicate explicit ordinal is rejected.
      await expect(ins('dup', 1)).rejects.toThrow(/chunk_version_ordinal_key/);
    });

    it('concurrent inserts for one version get distinct ordinals', async () => {
      const { content, version } = await uploaded();
      const mk = async () => {
        const c = new pg.Client({ connectionString: adminUrl });
        await c.connect();
        return c;
      };
      const [c1, c2] = [await mk(), await mk()];
      try {
        const sql = `INSERT INTO chunk (org_id, content_version_id, content_id, text) VALUES ($1, $2, $3, $4) RETURNING ordinal`;
        const run = async (c: pg.Client, tag: string) => {
          const got: number[] = [];
          for (let i = 0; i < 5; i += 1)
            got.push(
              (await c.query<{ ordinal: number }>(sql, [org.orgId, version, content, `${tag}${i}`]))
                .rows[0]!.ordinal,
            );
          return got;
        };
        const rs = (await Promise.all([run(c1, 'a'), run(c2, 'b')])).flat();
        expect(new Set(rs).size).toBe(10);
      } finally {
        await c1.end();
        await c2.end();
      }
    });
  });
});
