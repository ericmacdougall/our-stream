// SPDX-License-Identifier: AGPL-3.0-only
// Shared setup for the API integration suites: real Postgres (admin + RLS-bound app role), real S3
// endpoint (SeaweedFS), fake mailer. Each suite uses its own slug/email suffix so suites can run in
// parallel against one database.
import type { FastifyInstance, InjectOptions } from 'fastify';
import pg from 'pg';
import type { FixtureOrg } from '@our-stream/authz';
import { createPool, runMigrations } from '@our-stream/db';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { FakeMailer } from './lib/mailer.js';
import { createS3Store, derivedPrefix, type ObjectStore } from './lib/storage.js';
import { MemoryStore } from './test-memory-store.js';

export const adminUrl = process.env['DATABASE_ADMIN_URL'];
export const appUrl = process.env['DATABASE_URL'];
export const s3Endpoint = process.env['S3_ENDPOINT'];
/**
 * `TEST_STORE=memory` swaps SeaweedFS for the in-process store (test-memory-store.ts) so the suites run
 * where no container can be started; CI keeps using the real S3 endpoint.
 */
export const memoryStore = process.env['TEST_STORE'] === 'memory';
export const integrationReady = Boolean(adminUrl && appUrl && (s3Endpoint || memoryStore));

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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
  /** Every log line the API wrote (JSON per line); used to assert what must never be logged. */
  logs: string[];
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
  opts: { store?: ObjectStore } = {},
): Promise<Harness> {
  if (!adminUrl || !appUrl || !(s3Endpoint || memoryStore || opts.store))
    throw new Error('integration env missing');
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
    S3_ENDPOINT: s3Endpoint ?? 'http://127.0.0.1:1',
    S3_BUCKET: process.env['S3_BUCKET'] ?? 'ourstream-test',
    S3_ACCESS_KEY: process.env['S3_ACCESS_KEY'] ?? 'ourstream-dev',
    S3_SECRET_KEY: process.env['S3_SECRET_KEY'] ?? 'ourstream-dev-secret-only',
    AUTH_RATE_LIMIT_MAX: '10000',
    ...overrides,
  });
  let ownMemory: MemoryStore | null = null;
  let store: ObjectStore;
  if (opts.store) {
    store = opts.store;
  } else if (memoryStore) {
    ownMemory = new MemoryStore();
    await ownMemory.start();
    store = ownMemory;
  } else {
    store = createS3Store(config);
  }
  await store.ensureBucket();
  const logs: string[] = [];
  const logSink = {
    write(line: string) {
      logs.push(line);
    },
  };
  const app = await buildApp({ config, pool, version: 'test', mailer, store, logSink });
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
    const storageUrl = `${s3Endpoint ?? 'http://memory.invalid'}/${config.S3_BUCKET}/${prefix}hls/1080p/index.m3u8`;
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
    await ownMemory?.stop();
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
    logs,
    cleanup,
  };
}

/** A transcript every fixture version carries when `seedFixtureOrg` is asked for one (search tests). */
export const FIXTURE_TRANSCRIPT = {
  language: 'en',
  segments: [
    { start_ms: 0, end_ms: 3000, text: 'welcome everyone' },
    { start_ms: 40_000, end_ms: 44_000, text: 'the quarterly budget review starts now' },
    { start_ms: 44_000, end_ms: 47_000, text: 'questions at the end' },
  ],
};

/**
 * Seeds one authz fixture org like packages/authz matrix.integration.ts, with playable current
 * versions (and a transcript when asked) so API suites can compare feed, search and counts against the
 * reference implementation cell by cell.
 */
export async function seedFixtureOrg(
  h: Harness,
  org: FixtureOrg,
  opts: { transcript?: boolean } = {},
): Promise<void> {
  const admin = h.admin;
  await admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
  await admin.query('INSERT INTO org (id, slug, name, settings) VALUES ($1, $2, $2, $3::jsonb)', [
    org.orgId,
    org.slug,
    JSON.stringify({ documents_enabled: org.documentsEnabled }),
  ]);
  for (const m of org.memberships)
    await admin.query(
      'INSERT INTO org_membership (org_id, user_id, role, status) VALUES ($1, $2, $3, $4)',
      [org.orgId, m.userId, m.role, m.status],
    );
  for (const g of org.groups)
    await admin.query(
      'INSERT INTO "group" (org_id, id, name, is_private) VALUES ($1, $2, $3, $4)',
      [org.orgId, g.id, g.id, g.isPrivate],
    );
  for (const [name, id] of Object.entries(org.streamNames)) {
    await admin.query(
      'INSERT INTO stream (org_id, id, kind, slug, name) VALUES ($1, $2, $3, $4, $4)',
      [
        org.orgId,
        id,
        name === 'company' ? 'company' : name === 'department' ? 'department' : 'private',
        name,
      ],
    );
  }
  for (const c of org.content) {
    await admin.query(
      `INSERT INTO content (org_id, id, kind, owner_id, title, state, publish_at, expires_at, retracted_at, review_requested)
       VALUES ($1, $2, $10::content_kind, $3, $4, $5, $6, $7, $8, $9)`,
      [
        org.orgId,
        c.id,
        c.ownerId,
        `title ${c.id.slice(0, 8)}`,
        c.state,
        c.publishAt,
        c.expiresAt,
        c.retractedAt,
        c.reviewRequested,
        c.kind,
      ],
    );
    if (c.kind === 'document') {
      // A document fixture: a version in the stated status with an original and, whatever its status, three
      // chunks of searchable text (retrieval and search must not be fooled by chunks of a hidden version).
      if (c.currentVersionStatus === null) continue; // a document without any version row
      const v = await admin.query<{ id: string }>(
        `INSERT INTO content_version (org_id, content_id, status, original_key, original_name, original_size, mime_type, processing_step)
         VALUES ($1, $2, $3, $4, 'fixture.pdf', 1234, 'application/pdf', 'done') RETURNING id`,
        [org.orgId, c.id, c.currentVersionStatus, `orgs/${org.orgId}/fixture/${c.id}`],
      );
      await admin.query(
        'UPDATE content SET current_version_id = $3 WHERE org_id = $1 AND id = $2',
        [org.orgId, c.id, v.rows[0]!.id],
      );
      for (let i = 0; i < 3; i += 1)
        await admin.query(
          `INSERT INTO chunk (org_id, content_version_id, content_id, locator, text, ordinal) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            org.orgId,
            v.rows[0]!.id,
            c.id,
            JSON.stringify({ page: i + 1 }),
            `fixture onboarding policy page ${i + 1} of ${c.id.slice(0, 8)}`,
            i + 1,
          ],
        );
      continue;
    }
    const v = await admin.query<{ id: string }>(
      `INSERT INTO content_version (org_id, content_id, status, assets, transcript) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id`,
      [
        org.orgId,
        c.id,
        c.state === 'retracted' ? 'retracted' : 'current',
        JSON.stringify({ hls: { master: 'hls/master.m3u8' } }),
        opts.transcript ? JSON.stringify(FIXTURE_TRANSCRIPT) : null,
      ],
    );
    await admin.query('UPDATE content SET current_version_id = $3 WHERE org_id = $1 AND id = $2', [
      org.orgId,
      c.id,
      v.rows[0]!.id,
    ]);
  }
  for (const t of org.tuples) {
    await admin.query(
      `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        org.orgId,
        t.objectType,
        t.objectId,
        t.relation,
        t.subjectType,
        t.subjectId,
        t.subjectRelation,
      ],
    );
  }
  await admin.query(`SELECT set_config('app.org_id', '', false)`);
}

/** Inserts the fixture's user accounts and both orgs, and opens one session per (org, user). */
export async function seedFixtureSessions(
  h: Harness,
  fixture: { users: Record<string, string>; orgs: FixtureOrg[] },
  opts: { transcript?: boolean } = {},
): Promise<Map<string, string>> {
  const { randomUUID } = await import('node:crypto');
  const { sha256 } = await import('./lib/tokens.js');
  const cookies = new Map<string, string>();
  await h.admin.query('BEGIN');
  for (const [name, id] of Object.entries(fixture.users)) {
    await h.admin.query(
      'INSERT INTO platform.user_account (id, email, email_normalized, display_name) VALUES ($1, $2, $2, $3)',
      [id, `api-${h.suffix}-fx-${name}-${id.slice(0, 8)}@example.invalid`, name],
    );
  }
  for (const org of fixture.orgs) await seedFixtureOrg(h, org, opts);
  await h.admin.query('COMMIT');
  for (const org of fixture.orgs) {
    for (const [name, userId] of Object.entries(fixture.users)) {
      const token = `fx-${org.slug}-${name}-${randomUUID()}`;
      await h.admin.query(`SELECT platform_session_create($1, $2, $3, interval '1 hour')`, [
        userId,
        org.orgId,
        sha256(token),
      ]);
      cookies.set(`${org.orgId}:${userId}`, token);
    }
  }
  return cookies;
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
