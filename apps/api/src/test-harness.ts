// SPDX-License-Identifier: AGPL-3.0-only
// Shared setup for the API integration suites: real Postgres (admin + RLS-bound app role), real S3
// endpoint (SeaweedFS), fake mailer. Each suite uses its own slug/email suffix so suites can run in
// parallel against one database.
import type { FastifyInstance, InjectOptions } from 'fastify';
import pg from 'pg';
import { createPool, runMigrations } from '@our-stream/db';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { FakeMailer } from './lib/mailer.js';
import { createS3Store, derivedPrefix, type ObjectStore } from './lib/storage.js';

export const adminUrl = process.env['DATABASE_ADMIN_URL'];
export const appUrl = process.env['DATABASE_URL'];
export const s3Endpoint = process.env['S3_ENDPOINT'];
export const integrationReady = Boolean(adminUrl && appUrl && s3Endpoint);

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
  orgId: string | null;
  email: string;
}

export interface Harness {
  app: FastifyInstance;
  admin: pg.Client;
  pool: pg.Pool;
  mailer: FakeMailer;
  store: ObjectStore;
  config: Config;
  suffix: string;
  email: (name: string) => string;
  /** Injects as the given session (cookie + CSRF header) or anonymously. */
  call: (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    session?: Session | null,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: unknown; headers: Record<string, unknown>; raw: string }>;
  signup: (name: string, slug: string) => Promise<Session>;
  /** Owner invites `name`; the fake mailer's link is consumed and the new member's session returned. */
  invite: (
    owner: Session,
    name: string,
    role: 'admin' | 'announcer' | 'contributor' | 'member' | 'auditor',
  ) => Promise<Session>;
  consumeLastLink: (email: string) => Promise<Session>;
  /** Marks a version current with the given assets (what the worker does through platform_version_update). */
  makeCurrent: (
    orgId: string,
    contentId: string,
    versionId: string,
    assets: unknown,
  ) => Promise<void>;
  /** Writes a tiny HLS tree under the version's derived/ prefix and returns the assets object for it. */
  seedHls: (
    orgId: string,
    contentId: string,
    versionId: string,
  ) => Promise<Record<string, unknown>>;
  /** Inserts a bare version row (bypassing upload) and returns its id. */
  insertVersion: (orgId: string, contentId: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

function tokenFromLink(text: string): string {
  const m = /token=([A-Za-z0-9_%-]+)/.exec(text);
  if (!m) throw new Error('no token in mail');
  return decodeURIComponent(m[1]!);
}

export async function createHarness(
  suffix: string,
  overrides: Partial<Record<string, string>> = {},
): Promise<Harness> {
  if (!adminUrl || !appUrl || !s3Endpoint) throw new Error('integration env missing');
  await runMigrations(adminUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const pool = createPool(appUrl);
  const mailer = new FakeMailer();
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: appUrl,
    APP_BASE_URL: 'http://localhost:3000',
    S3_ENDPOINT: s3Endpoint,
    S3_BUCKET: process.env['S3_BUCKET'] ?? 'ourstream-test',
    S3_ACCESS_KEY: process.env['S3_ACCESS_KEY'] ?? 'ourstream-dev',
    S3_SECRET_KEY: process.env['S3_SECRET_KEY'] ?? 'ourstream-dev-secret-only',
    AUTH_RATE_LIMIT_MAX: '10000',
    ...overrides,
  });
  const store = createS3Store(config);
  await store.ensureBucket();
  const app = await buildApp({ config, pool, version: 'test', mailer, store });
  await app.ready();

  const email = (name: string) => `api-${suffix}-${name}@example.invalid`;

  const call: Harness['call'] = async (method, url, session, body, headers = {}) => {
    const opts: InjectOptions = { method, url, headers: { ...headers } };
    if (session) {
      opts.cookies = { os_session: session.cookie };
      opts.headers = { 'x-csrf-token': session.csrf, ...headers };
    }
    if (body !== undefined) opts.payload = body as NonNullable<InjectOptions['payload']>;
    const res = await app.inject(opts);
    const parsed = ((): unknown => {
      try {
        return res.json();
      } catch {
        return null;
      }
    })();
    return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.body };
  };

  const sessionFrom = (res: Awaited<ReturnType<typeof app.inject>>, emailAddr: string): Session => {
    const cookie = res.cookies.find((c) => c.name === 'os_session');
    if (!cookie) throw new Error(`no session cookie (status ${res.statusCode}: ${res.body})`);
    const me = res.json() as {
      user: { id: string };
      org: { id: string } | null;
      csrfToken: string;
    };
    return {
      cookie: cookie.value,
      csrf: me.csrfToken,
      userId: me.user.id,
      orgId: me.org?.id ?? null,
      email: emailAddr,
    };
  };

  const signup: Harness['signup'] = async (name, slug) => {
    const addr = email(name);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: addr,
        password: 'correct-horse-battery-staple',
        displayName: name,
        orgName: `Org ${slug}`,
        orgSlug: `${slug}-${suffix}`,
      },
    });
    if (res.statusCode !== 200) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
    return sessionFrom(res, addr);
  };

  const consumeLastLink: Harness['consumeLastLink'] = async (addr) => {
    const mail = mailer.lastTo(addr);
    if (!mail) throw new Error(`no mail for ${addr}`);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/consume',
      payload: { token: tokenFromLink(mail.text) },
    });
    if (res.statusCode !== 200) throw new Error(`consume failed: ${res.statusCode} ${res.body}`);
    return sessionFrom(res, addr);
  };

  const invite: Harness['invite'] = async (owner, name, role) => {
    const addr = email(name);
    const r = await call('POST', '/v1/invites', owner, { email: addr, role });
    if (r.status !== 200) throw new Error(`invite failed: ${r.status} ${r.raw}`);
    return consumeLastLink(addr);
  };

  const withOrg = async (orgId: string, fn: () => Promise<void>) => {
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    try {
      await fn();
    } finally {
      await admin.query(`SELECT set_config('app.org_id', '', false)`);
    }
  };

  const makeCurrent: Harness['makeCurrent'] = (orgId, contentId, versionId, assets) =>
    withOrg(orgId, async () => {
      await admin.query(
        `UPDATE content_version SET status = 'superseded' WHERE org_id = $1 AND content_id = $2 AND status = 'current'`,
        [orgId, contentId],
      );
      await admin.query(
        `UPDATE content_version SET status = 'current', assets = $3::jsonb, processing_step = 'done', processed_at = now(), duration_ms = 60000, width = 1080, height = 1920
         WHERE org_id = $1 AND id = $2`,
        [orgId, versionId, JSON.stringify(assets)],
      );
      await admin.query(
        'UPDATE content SET current_version_id = $3 WHERE org_id = $1 AND id = $2',
        [orgId, contentId, versionId],
      );
    });

  const insertVersion: Harness['insertVersion'] = async (orgId, contentId) => {
    let id = '';
    await withOrg(orgId, async () => {
      const r = await admin.query<{ id: string }>(
        `INSERT INTO content_version (org_id, content_id, status, processing_step) VALUES ($1, $2, 'uploaded', 'uploaded') RETURNING id`,
        [orgId, contentId],
      );
      id = r.rows[0]!.id;
    });
    return id;
  };

  const seedHls: Harness['seedHls'] = async (orgId, contentId, versionId) => {
    const prefix = derivedPrefix(orgId, contentId, versionId);
    const storageUrl = `${s3Endpoint}/${config.S3_BUCKET}/${prefix}hls/1080p/index.m3u8`;
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="../captions/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=720x1280,SUBTITLES="subs"',
      '720p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1080x1920,SUBTITLES="subs"',
      storageUrl,
      '',
    ].join('\n');
    const rendition = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4.0,',
      'seg0.m4s',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    await store.put(`${prefix}hls/master.m3u8`, master, 'application/vnd.apple.mpegurl');
    await store.put(`${prefix}hls/720p/index.m3u8`, rendition, 'application/vnd.apple.mpegurl');
    await store.put(`${prefix}hls/720p/init.mp4`, Buffer.from('init-bytes'), 'video/mp4');
    await store.put(
      `${prefix}hls/720p/seg0.m4s`,
      Buffer.from('0123456789abcdef'),
      'video/iso.segment',
    );
    await store.put(
      `${prefix}captions/en.vtt`,
      'WEBVTT\n\n00:00.000 --> 00:02.000\nhello\n',
      'text/vtt',
    );
    await store.put(`${prefix}poster.jpg`, Buffer.from('jpegbytes'), 'image/jpeg');
    return {
      hls: { master: `${prefix}hls/master.m3u8`, renditions: ['720p', '1080p'] },
      poster: `${prefix}poster.jpg`,
      sprite: null,
      spriteVtt: null,
      captions: { en: `${prefix}captions/en.vtt` },
    };
  };

  const cleanup = async () => {
    await admin.query(`DELETE FROM org WHERE slug LIKE $1`, [`%-${suffix}`]);
    await admin.query(`DELETE FROM platform.user_account WHERE email_normalized LIKE $1`, [
      `api-${suffix}-%`,
    ]);
    await app.close();
    await pool.end();
    await admin.end();
  };

  return {
    app,
    admin,
    pool,
    mailer,
    store,
    config,
    suffix,
    email,
    call,
    signup,
    invite,
    consumeLastLink,
    makeCurrent,
    seedHls,
    insertVersion,
    cleanup,
  };
}

/** Creates a stream as an admin and grants roles; returns the stream id. */
export async function createStream(
  h: Harness,
  admin: Session,
  slug: string,
  kind: 'department' | 'team' | 'project' | 'private',
  grants: Array<{ session: Session; role: 'viewer' | 'contributor' | 'moderator' | 'owner' }>,
): Promise<string> {
  const r = await h.call('POST', '/v1/streams', admin, {
    kind,
    slug: `${slug}-${h.suffix}`,
    name: slug,
  });
  if (r.status !== 200) throw new Error(`stream create failed: ${r.status} ${r.raw}`);
  const id = (r.body as { id: string }).id;
  for (const g of grants) {
    const gr = await h.call('POST', `/v1/streams/${id}/grants`, admin, {
      role: g.role,
      subject: { type: 'user', userId: g.session.userId },
    });
    if (gr.status !== 200) throw new Error(`grant failed: ${gr.status} ${gr.raw}`);
  }
  return id;
}

/** Creates content as `author`, gives it a current version with playable assets, and returns ids. */
export async function createPlayableContent(
  h: Harness,
  author: Session,
  title: string,
): Promise<{ contentId: string; versionId: string }> {
  const c = await h.call('POST', '/v1/content', author, { kind: 'clip', title });
  if (c.status !== 200) throw new Error(`content create failed: ${c.status} ${c.raw}`);
  const contentId = (c.body as { id: string }).id;
  const versionId = await h.insertVersion(author.orgId!, contentId);
  const assets = await h.seedHls(author.orgId!, contentId, versionId);
  await h.makeCurrent(author.orgId!, contentId, versionId, assets);
  return { contentId, versionId };
}
