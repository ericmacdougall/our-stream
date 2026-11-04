// SPDX-License-Identifier: AGPL-3.0-only
// M1a worker end to end against Postgres (admin seeds, platform role runs) and an S3 endpoint.
// W1 media.process on a generated 12 s 720x1280 clip; W2 corrupt input fails cleanly; W3 transition
// bumps the epoch and fans out publish notifications idempotently; W4 retraction notifies exactly the
// viewers of that version once, with the title snapshot only when the org opted in.
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runMigrations } from '@our-stream/db';
import {
  createObjectStore,
  execTool,
  limitsFromEnv,
  probe,
  s3ConfigFromEnv,
  type ObjectStore,
} from '@our-stream/pipeline';
import { createFakeAsr } from '@our-stream/providers';
import type { JobContext } from './jobs.js';
import { mediaProcess, derivedPrefix } from './media.js';
import { drainOnce } from './outbox.js';
import { contentTransition } from './transition.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL'];
const s3Ready = Boolean(process.env['S3_ENDPOINT'] && process.env['S3_BUCKET']);
const enabled = Boolean(adminUrl && platformUrl && s3Ready);

describe.skipIf(!enabled)('worker (integration)', () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const platform = new pg.Pool({ connectionString: platformUrl, max: 2 });
  let store: ObjectStore;
  let work: string;
  let errors: string[] = [];
  let ctx: JobContext & { sent: unknown[] };
  const ids = {
    owner: '',
    v1: '',
    v2: '',
    n3: '',
    org: '',
    content: '',
    version: '',
    badVersion: '',
  };

  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await admin.query<T>(sql, params)).rows;

  beforeAll(async () => {
    await runMigrations(adminUrl!);
    store = createObjectStore(s3ConfigFromEnv());
    await store.ensureBucket();
    work = await mkdtemp(join(tmpdir(), 'worker-it-'));
    const sent: unknown[] = [];
    errors = [];
    ctx = {
      tenantPool: platform,
      platformPool: platform,
      queue: {
        send: async (name, data, options) => {
          sent.push({ name, data, options });
          return 'id';
        },
      },
      store,
      asr: createFakeAsr(),
      limits: { ...limitsFromEnv({}), threads: 8, tmpRoot: join(work, 'tmp') },
      mailer: { send: async () => undefined },
      appBaseUrl: 'http://localhost:3000',
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (o, msg) => errors.push(`${msg ?? ''} ${JSON.stringify(o)}`),
      },
      now: () => new Date(),
      sent,
    };

    // Seed one org with an owner, two future viewers and one non-viewer (admin role bypasses RLS).
    const tag = randomBytes(4).toString('hex');
    const mkUser = async (name: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO platform.user_account (email, email_normalized, display_name) VALUES ($1, $1, $2) RETURNING id`,
          [`${name}-${tag}@example.test`, name],
        )
      )[0]!.id;
    ids.owner = await mkUser('owner');
    ids.v1 = await mkUser('viewer1');
    ids.v2 = await mkUser('viewer2');
    ids.n3 = await mkUser('nonviewer');
    ids.org = (
      await q<{ id: string }>(`SELECT platform_org_create($1, $2, $3) AS id`, [
        ids.owner,
        `wk-${tag}`,
        'Worker IT',
      ])
    )[0]!.id;
    for (const u of [ids.v1, ids.v2, ids.n3])
      await q(
        `INSERT INTO org_membership (org_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`,
        [ids.org, u],
      );
    ids.content = (
      await q<{ id: string }>(
        `INSERT INTO content (org_id, kind, owner_id, title, language) VALUES ($1, 'clip', $2, 'Worker clip', 'en') RETURNING id`,
        [ids.org, ids.owner],
      )
    )[0]!.id;
    // Audience: the whole org (content viewer ← org#member), through the tuple trigger.
    await q(
      `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation, created_by)
       VALUES ($1, 'content', $2, 'viewer', 'org', $1, 'member', $3)`,
      [ids.org, ids.content, ids.owner],
    );
    const mkVersion = async (suffix: string) => {
      const id = (
        await q<{ id: string }>(
          `INSERT INTO content_version (org_id, content_id, status, original_key, mime_type) VALUES ($1, $2, 'uploaded', 'pending', 'video/mp4') RETURNING id`,
          [ids.org, ids.content],
        )
      )[0]!.id;
      const key = `orgs/${ids.org}/content/${ids.content}/versions/${id}/original/${suffix}`;
      await q(`UPDATE content_version SET original_key = $3 WHERE org_id = $1 AND id = $2`, [
        ids.org,
        id,
        key,
      ]);
      return { id, key };
    };
    const good = await mkVersion('clip');
    ids.version = good.id;
    const bad = await mkVersion('corrupt');
    ids.badVersion = bad.id;

    // 12 s 720x1280 test clip with a tone; generated here so the repository holds no media fixtures.
    const clip = join(work, 'clip.mp4');
    await execTool(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=720x1280:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '12',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        clip,
      ],
      { timeoutMs: 120_000 },
    );
    await store.putObject(good.key, await readFile(clip), 'video/mp4');
    await store.putObject(bad.key, randomBytes(64 * 1024), 'video/mp4');
  });

  afterAll(async () => {
    if (ids.org) {
      await store.deletePrefix(`orgs/${ids.org}/`).catch(() => undefined);
      await admin.query('DELETE FROM org WHERE id = $1', [ids.org]).catch(() => undefined);
      await admin
        .query('DELETE FROM platform.user_account WHERE id = ANY($1::uuid[])', [
          [ids.owner, ids.v1, ids.v2, ids.n3],
        ])
        .catch(() => undefined);
    }
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await admin.end();
    await platform.end();
  });

  const job = () => ({ orgId: ids.org, contentId: ids.content, versionId: ids.version });

  async function downloadDerived(prefix: string, dest: string): Promise<string[]> {
    const keys = await store.list(`${prefix}/`);
    for (const key of keys) {
      const rel = key.slice(prefix.length + 1);
      const target = join(dest, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await store.getObject(key));
    }
    return keys;
  }

  it('W1: media.process makes the version current with the expected ladder and assets', async () => {
    await mediaProcess(job(), ctx);
    const [version] = await q<{
      status: string;
      processing_step: string;
      processing_error: string | null;
      assets: Record<string, unknown>;
      transcript: Record<string, unknown>;
      duration_ms: number;
      width: number;
      height: number;
      processed_at: Date | null;
    }>(
      'SELECT status, processing_step, processing_error, assets, transcript, duration_ms, width, height, processed_at FROM content_version WHERE org_id = $1 AND id = $2',
      [ids.org, ids.version],
    );
    expect(version).toMatchObject({
      status: 'current',
      processing_step: 'done',
      processing_error: null,
      width: 720,
      height: 1280,
    });
    expect(version!.duration_ms).toBeGreaterThanOrEqual(11_900);
    expect(version!.duration_ms).toBeLessThanOrEqual(12_200);
    expect(version!.processed_at).not.toBeNull();
    const assets = version!.assets as {
      hls: {
        master: string;
        renditions: { name: string; width: number; height: number; playlist: string }[];
      };
      poster: string;
      sprite: string;
      spriteVtt: string;
      captions: Record<string, string>;
    };
    expect(assets.hls.master).toBe('hls/master.m3u8');
    expect(assets.hls.renditions.map((r) => [r.name, r.width, r.height])).toEqual([
      ['720p', 720, 1280],
      ['540p', 540, 960],
      ['360p', 360, 640],
    ]);
    expect(assets).toMatchObject({
      poster: 'poster.jpg',
      sprite: 'sprite.jpg',
      spriteVtt: 'sprite.vtt',
      captions: { en: 'captions/en.vtt' },
    });
    const transcript = version!.transcript as {
      language: string;
      segments: { start_ms: number; end_ms: number; text: string }[];
    };
    expect(transcript.language).toBe('en');
    expect(transcript.segments).toHaveLength(3);
    const [content] = await q<{ current_version_id: string }>(
      'SELECT current_version_id FROM content WHERE org_id = $1 AND id = $2',
      [ids.org, ids.content],
    );
    expect(content!.current_version_id).toBe(ids.version);

    // Storage: every asset referenced exists under the derived prefix; download and inspect with ffprobe.
    const prefix = derivedPrefix(job());
    const local = join(work, 'derived1');
    const keys = await downloadDerived(prefix, local);
    const rel = keys.map((k) => k.slice(prefix.length + 1));
    for (const expected of [
      'hls/master.m3u8',
      'poster.jpg',
      'sprite.jpg',
      'sprite.vtt',
      'captions/en.vtt',
      'hls/720p/index.m3u8',
      'hls/720p/init_0.mp4',
      'hls/360p/seg_000.m4s',
    ])
      expect(rel).toContain(expected);
    const master = await readFile(join(local, 'hls/master.m3u8'), 'utf8');
    const resolutions = [...master.matchAll(/RESOLUTION=(\d+x\d+)/g)].map((m) => m[1]);
    expect(resolutions.sort()).toEqual(['360x640', '540x960', '720x1280']);
    expect(master).not.toContain('1080x1920');
    const variant = await readFile(join(local, 'hls/360p/index.m3u8'), 'utf8');
    expect(variant).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
    expect(variant).toMatch(/#EXT-X-MAP:URI="init_\d+\.mp4"/); // ffmpeg suffixes the variant index
    const durations = [...variant.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    expect(durations.length).toBe(3); // 12 s / 4 s segments
    for (const d of durations.slice(0, -1)) expect(d).toBeCloseTo(4, 0);
    const probed = await probe(join(local, 'hls/master.m3u8'), { timeoutMs: 60_000 });
    expect(probed.hasVideo && probed.hasAudio).toBe(true);
    expect(probed.durationMs).toBeGreaterThanOrEqual(11_900);
    const r360 = await probe(join(local, 'hls/360p/index.m3u8'), { timeoutMs: 60_000 });
    expect([r360.width, r360.height]).toEqual([360, 640]);
    expect(r360.videoCodec).toBe('h264');
    expect(r360.audioCodec).toBe('aac');
    // Keyframe cadence: 2 s GOP at 30 fps.
    const { stdout } = await execTool(
      'ffprobe',
      [
        '-v',
        'error',
        '-skip_frame',
        'nokey',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=pts_time',
        '-of',
        'csv=p=0',
        join(local, 'hls/360p/index.m3u8'),
      ],
      { timeoutMs: 60_000 },
    );
    const keyTimes = stdout
      .trim()
      .split('\n')
      .map((l) => Number(l.split(',').find((f) => f.trim() !== '' && f.trim() !== 'frame')))
      .filter((n) => Number.isFinite(n));
    expect(keyTimes.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < keyTimes.length; i += 1)
      expect(keyTimes[i]! - keyTimes[i - 1]!).toBeCloseTo(2, 1);
    const sprite = await readFile(join(local, 'sprite.vtt'), 'utf8');
    expect(sprite).toContain('sprite.jpg#xywh=0,0,108,192');
    const captions = await readFile(join(local, 'captions/en.vtt'), 'utf8');
    expect(captions.startsWith('WEBVTT')).toBe(true);
    expect(captions).toContain('00:00:00.000 --> 00:00:04.000');
    const posterInfo = await probe(join(local, 'poster.jpg'), { timeoutMs: 30_000 });
    expect([posterInfo.width, posterInfo.height]).toEqual([720, 1280]);

    // Idempotent re-run: same outcome, same key set, no leftovers.
    await mediaProcess(job(), ctx);
    expect(await store.list(`${prefix}/`)).toEqual(keys);
    const [again] = await q<{ status: string }>(
      'SELECT status FROM content_version WHERE org_id = $1 AND id = $2',
      [ids.org, ids.version],
    );
    expect(again!.status).toBe('current');
    // Temp dir strictly cleaned.
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(work, 'tmp'))).toEqual([]);
  });

  it('W2: a corrupt upload ends as failed with a path-free error and no derived keys', async () => {
    const bad = { orgId: ids.org, contentId: ids.content, versionId: ids.badVersion };
    const rejections: unknown[] = [];
    const onUnhandled = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(mediaProcess(bad, ctx)).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(rejections).toEqual([]);
    const [version] = await q<{
      status: string;
      processing_step: string;
      processing_error: string;
    }>(
      'SELECT status, processing_step, processing_error FROM content_version WHERE org_id = $1 AND id = $2',
      [ids.org, ids.badVersion],
    );
    expect(version!.status).toBe('failed');
    expect(version!.processing_step).toBe('probe');
    expect(version!.processing_error).toMatch(/^probe: /);
    expect(version!.processing_error).not.toMatch(/\//);
    expect(version!.processing_error).not.toContain(work);
    expect(await store.list(`${derivedPrefix(bad)}/`)).toEqual([]);
    // The good version stays current.
    const [content] = await q<{ current_version_id: string }>(
      'SELECT current_version_id FROM content WHERE org_id = $1 AND id = $2',
      [ids.org, ids.content],
    );
    expect(content!.current_version_id).toBe(ids.version);
  });

  it('W3: the publish transition bumps the epoch, emits content.published and fans out once', async () => {
    const publishAt = new Date(Date.now() - 1000);
    await q(
      `UPDATE content SET state = 'published', publish_at = $3 WHERE org_id = $1 AND id = $2`,
      [ids.org, ids.content, publishAt],
    );
    const [before] = await q<{ content_epoch: string }>(
      'SELECT content_epoch::text FROM content WHERE org_id = $1 AND id = $2',
      [ids.org, ids.content],
    );
    // Scheduling reads the row, not the payload.
    await drainOnce(ctx); // nothing pending yet; proves an empty drain is harmless
    const scheduled = await admin.query(
      `INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload) VALUES ($1, 'content.scheduled', 'content', $2, $3, '{}') RETURNING id`,
      [ids.org, ids.content, ids.version],
    );
    await drainOnce(ctx);
    const sends = ctx.sent as {
      name: string;
      data: { kind: string; at: string };
      options: { startAfter: Date };
    }[];
    const publishJob = sends.find(
      (s) => s.name === 'content.transition' && s.data.kind === 'publish',
    );
    expect(publishJob).toBeDefined();
    expect(new Date(publishJob!.data.at).getTime()).toBe(publishAt.getTime());
    expect(sends.some((s) => s.data.kind === 'expire')).toBe(false);
    const [marked] = await q<{ processed_at: Date | null }>(
      'SELECT processed_at FROM platform.domain_event WHERE id = $1',
      [scheduled.rows[0].id],
    );
    expect(marked!.processed_at).not.toBeNull();

    await contentTransition(publishJob!.data as unknown, ctx);
    const [after] = await q<{ content_epoch: string }>(
      'SELECT content_epoch::text FROM content WHERE org_id = $1 AND id = $2',
      [ids.org, ids.content],
    );
    expect(Number(after!.content_epoch)).toBe(Number(before!.content_epoch) + 1);
    const events = await q<{ id: string; version_id: string; processed_at: Date | null }>(
      `SELECT id, version_id, processed_at FROM platform.domain_event WHERE org_id = $1 AND type = 'content.published' AND subject_id = $2`,
      [ids.org, ids.content],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.version_id).toBe(ids.version);

    // Re-running the same transition job is a no-op only when rescheduled; a replay here re-applies,
    // which is why the queue is stately per instant. Verify the drain fan-out and its idempotency.
    // The database may hold unprocessed events from other runs; only this org's outcome matters.
    const drained = await drainOnce(ctx);
    expect(errors.filter((e) => e.includes(ids.org) && e.includes('outbox'))).toEqual([]);
    expect(drained.processed).toBeGreaterThanOrEqual(1);
    const notified = async () =>
      q<{ user_id: string; reason: string; title_snapshot: string | null }>(
        `SELECT user_id, reason, title_snapshot FROM notification WHERE org_id = $1 AND kind = 'content.published' AND dedupe_key = $2 ORDER BY user_id`,
        [ids.org, `published:${ids.version}`],
      );
    const first = await notified();
    expect(first.map((n) => n.user_id).sort()).toEqual([ids.owner, ids.v1, ids.v2, ids.n3].sort());
    expect(first.every((n) => n.reason === 'audience' && n.title_snapshot === null)).toBe(true);
    await q('UPDATE platform.domain_event SET processed_at = NULL WHERE id = $1', [events[0]!.id]);
    await drainOnce(ctx);
    expect((await notified()).length).toBe(4);
  });

  it('W4: retraction notifies exactly the viewers of that version once; title only when opted in', async () => {
    // v1 and v2 viewed the current version (title snapshot recorded at view time); n3 never did.
    for (const u of [ids.v1, ids.v2])
      await q(
        `INSERT INTO user_content_state (org_id, user_id, content_id, first_viewed_at, last_viewed_at, last_version_id, title_snapshot)
         VALUES ($1, $2, $3, now(), now(), $4, 'Worker clip (as seen)')`,
        [ids.org, u, ids.content, ids.version],
      );
    await q(
      `UPDATE content SET state = 'retracted', retracted_at = now() WHERE org_id = $1 AND id = $2`,
      [ids.org, ids.content],
    );
    const ev = await admin.query<{ id: string }>(
      `INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload) VALUES ($1, 'content.retracted', 'content', $2, $3, '{}') RETURNING id`,
      [ids.org, ids.content, ids.version],
    );
    await drainOnce(ctx);
    const notices = async () =>
      q<{ user_id: string; reason: string; title_snapshot: string | null; version_id: string }>(
        `SELECT user_id, reason, title_snapshot, version_id FROM notification WHERE org_id = $1 AND kind = 'content.retracted' ORDER BY user_id`,
        [ids.org],
      );
    const first = await notices();
    expect(first.map((n) => n.user_id).sort()).toEqual([ids.v1, ids.v2].sort());
    expect(
      first.every(
        (n) =>
          n.reason === 'saw_version' && n.title_snapshot === null && n.version_id === ids.version,
      ),
    ).toBe(true);
    // Replay of the outbox row: no duplicates.
    await q('UPDATE platform.domain_event SET processed_at = NULL WHERE id = $1', [ev.rows[0]!.id]);
    await drainOnce(ctx);
    expect((await notices()).length).toBe(2);

    // Opt in: a retraction of another version carries the view-time title snapshot.
    await q(
      `UPDATE org SET settings = settings || '{"notify":{"include_title_after_access_loss":"true"}}'::jsonb WHERE id = $1`,
      [ids.org],
    );
    await q(
      `UPDATE user_content_state SET last_version_id = $3 WHERE org_id = $1 AND user_id = $2`,
      [ids.org, ids.v1, ids.badVersion],
    );
    await admin.query(
      `INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id, version_id, payload) VALUES ($1, 'content.retracted', 'content', $2, $3, '{}')`,
      [ids.org, ids.content, ids.badVersion],
    );
    await drainOnce(ctx);
    const withTitle = (await notices()).filter((n) => n.version_id === ids.badVersion);
    expect(withTitle).toEqual([
      {
        user_id: ids.v1,
        reason: 'saw_version',
        title_snapshot: 'Worker clip (as seen)',
        version_id: ids.badVersion,
      },
    ]);
  });

  it('platform role cannot read tenant tables directly (definer functions are the only path)', async () => {
    await expect(platform.query('SELECT count(*) FROM content')).rejects.toThrow(
      /permission denied/,
    );
    await expect(platform.query('SELECT count(*) FROM notification')).rejects.toThrow(
      /permission denied/,
    );
  });
});
