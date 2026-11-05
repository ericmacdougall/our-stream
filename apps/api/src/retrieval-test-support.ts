// SPDX-License-Identifier: AGPL-3.0-only
// Test support for the retrieval suites: a scratch database per suite (the suites toggle deployment-global
// state such as the kill switch and the embedding pins), direct-insert seeding that mirrors the authz fixture
// matrix, vectors seeded through the core function platform_embedding_upsert, and a deterministic fake
// embedder (the worker slice adds the real provider capability; this file defines no provider).
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createPool, runMigrations, withTenant, type TenantClient } from '@our-stream/db';
import type { Tuple } from '@our-stream/authz';
import { buildApp, type AppDeps } from './app.js';
import { loadConfig } from './config.js';
import { FakeMailer } from './lib/mailer.js';
import type { QueryEmbedder } from './lib/retrieval/embedder.js';
import { retrieve, type EngineInput, type EngineResult } from './lib/retrieval/engine.js';
import { TrySemaphore } from './lib/retrieval/semaphore.js';
import type { ObjectStore } from './lib/storage.js';
import { sha256 } from './lib/tokens.js';

export const adminUrl = process.env['DATABASE_ADMIN_URL'];
export const appUrl = process.env['DATABASE_URL'];
export const platformUrl = process.env['DATABASE_PLATFORM_URL'];
export const dbReady = Boolean(adminUrl && appUrl && platformUrl);

export const PIN_MODEL = 'Qwen3-Embedding-0.6B';
export const DEFAULT_PIN_ID = '5a7e0001-0000-4000-8000-000000000001';
export const DIMS = 1024;

// --- deterministic fake embedder -------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussians(rand: () => number, n: number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    out.push(r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v));
  }
  return out.slice(0, n);
}

const normalize = (v: number[]): number[] => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

export const TOPICS = 40;
const centers = new Map<number, number[]>();
function center(topic: number): number[] {
  let c = centers.get(topic);
  if (!c) {
    c = normalize(gaussians(mulberry32(1000 + topic), DIMS));
    centers.set(topic, c);
  }
  return c;
}

/** A clustered, deterministic, never-zero unit vector for a text (clusters mimic real embeddings). */
export function vectorFor(text: string): number[] {
  const h = createHash('sha256').update(text.normalize('NFC'), 'utf8').digest();
  const topic = h.readUInt32BE(0) % TOPICS;
  const noise = normalize(gaussians(mulberry32(h.readUInt32BE(4)), DIMS));
  const c = center(topic);
  return normalize(c.map((x, i) => x * 0.9 + noise[i]! * 0.45));
}

export const sha256Nfc = (text: string): Buffer =>
  createHash('sha256').update(text.normalize('NFC'), 'utf8').digest();

export class FakeEmbedder implements QueryEmbedder {
  model = PIN_MODEL;
  calls = 0;
  delayMs = 0;
  failWith: Error | null = null;
  async embed(text: string, signal: AbortSignal): Promise<number[]> {
    this.calls += 1;
    if (this.delayMs > 0)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    if (this.failWith) throw this.failWith;
    return vectorFor(text);
  }
}

// --- world -----------------------------------------------------------------------------------------------

export interface World {
  admin: pg.Client;
  app: pg.Pool;
  platform: pg.Pool;
  adminUrl: string;
  appUrl: string;
  platformUrl: string;
  close: () => Promise<void>;
}

function withDb(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function createWorld(prefix: string): Promise<World> {
  if (!adminUrl || !appUrl || !platformUrl) throw new Error('integration env missing');
  const name = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  // Migrations touch cluster-global objects (roles, default privileges): scratch databases created by
  // parallel suites must not run them at the same time ("tuple concurrently updated").
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query('SELECT pg_advisory_lock(7420011)');
  const a = withDb(adminUrl, name);
  const p = withDb(appUrl, name);
  const pl = withDb(platformUrl, name);
  try {
    await root.query(`CREATE DATABASE ${name}`);
    await root.query(`GRANT CONNECT ON DATABASE ${name} TO ourstream_app, ourstream_platform`);
    await runMigrations(a);
  } finally {
    await root.query('SELECT pg_advisory_unlock(7420011)');
    await root.end();
  }
  const admin = new pg.Client({ connectionString: a });
  await admin.connect();
  const app = createPool(p, { max: 12 });
  const platform = createPool(pl, { max: 6 });
  return {
    admin,
    app,
    platform,
    adminUrl: a,
    appUrl: p,
    platformUrl: pl,
    close: async () => {
      await admin.end();
      await app.end();
      await platform.end();
      const r = new pg.Client({ connectionString: adminUrl });
      await r.connect();
      await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await r.end();
    },
  };
}

// --- seeding -----------------------------------------------------------------------------------------------

export type Role = 'owner' | 'admin' | 'announcer' | 'contributor' | 'member' | 'auditor';

export async function insertUser(
  w: World,
  name: string,
  id: string = randomUUID(),
): Promise<string> {
  await w.admin.query(
    'INSERT INTO platform.user_account (id, email, email_normalized, display_name) VALUES ($1, $2, $2, $3)',
    [id, `rt-${name}-${id.slice(0, 8)}@example.invalid`, name],
  );
  return id;
}

export async function insertOrg(
  w: World,
  slug: string,
  settings: Record<string, unknown> | null,
  id: string = randomUUID(),
): Promise<string> {
  await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [id]);
  await w.admin.query('INSERT INTO org (id, slug, name, settings) VALUES ($1, $2, $2, $3::jsonb)', [
    id,
    slug,
    JSON.stringify(settings ?? {}),
  ]);
  return id;
}

export async function addMember(
  w: World,
  orgId: string,
  userId: string,
  role: Role,
  status: 'active' | 'deactivated' = 'active',
): Promise<void> {
  await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
  await w.admin.query(
    'INSERT INTO org_membership (org_id, user_id, role, status) VALUES ($1, $2, $3, $4)',
    [orgId, userId, role, status],
  );
}

export async function insertTuples(
  w: World,
  orgId: string,
  tuples: readonly Tuple[],
): Promise<void> {
  await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
  for (const t of tuples)
    await w.admin.query(
      `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, t.objectType, t.objectId, t.relation, t.subjectType, t.subjectId, t.subjectRelation],
    );
}

export async function insertGroup(w: World, orgId: string, id: string): Promise<void> {
  await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
  await w.admin.query(
    'INSERT INTO "group" (org_id, id, name, is_private) VALUES ($1, $2, $3, false)',
    [orgId, id, id],
  );
}

export async function insertStream(
  w: World,
  orgId: string,
  id: string,
  slug: string,
): Promise<void> {
  await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
  await w.admin.query(
    `INSERT INTO stream (org_id, id, kind, slug, name) VALUES ($1, $2, 'department', $3, $4)`,
    [orgId, id, slug, slug],
  );
}

export interface SeedContent {
  orgId: string;
  id?: string;
  kind: 'clip' | 'audio' | 'document';
  ownerId: string;
  state?: 'draft' | 'published' | 'retracted';
  publishAt?: Date | null;
  expiresAt?: Date | null;
  retractedAt?: Date | null;
  reviewRequested?: boolean;
  /** null = no version row at all. */
  versionStatus?:
    'uploaded' | 'processing' | 'current' | 'superseded' | 'retracted' | 'failed' | null;
  chunks: string[];
  audience?: Array<Pick<Tuple, 'subjectType' | 'subjectId' | 'subjectRelation'>>;
}

export interface SeededContent {
  contentId: string;
  versionId: string | null;
  chunkIds: string[];
}

export async function seedContent(w: World, c: SeedContent): Promise<SeededContent> {
  const id = c.id ?? randomUUID();
  await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [c.orgId]);
  await w.admin.query(
    `INSERT INTO content (org_id, id, kind, owner_id, title, state, publish_at, expires_at, retracted_at, review_requested)
     VALUES ($1, $2, $3::content_kind, $4, $5, $6, $7, $8, $9, $10)`,
    [
      c.orgId,
      id,
      c.kind,
      c.ownerId,
      `title ${id.slice(0, 8)}`,
      c.state ?? 'published',
      c.publishAt === undefined ? new Date(Date.now() - 3_600_000) : c.publishAt,
      c.expiresAt ?? null,
      c.retractedAt ?? null,
      c.reviewRequested ?? false,
    ],
  );
  let versionId: string | null = null;
  const chunkIds: string[] = [];
  if (c.versionStatus !== null) {
    const v = await w.admin.query<{ id: string }>(
      `INSERT INTO content_version (org_id, content_id, status) VALUES ($1, $2, $3) RETURNING id`,
      [c.orgId, id, c.versionStatus ?? 'current'],
    );
    versionId = v.rows[0]!.id;
    await w.admin.query(
      'UPDATE content SET current_version_id = $3 WHERE org_id = $1 AND id = $2',
      [c.orgId, id, versionId],
    );
    if (c.chunks.length > 0) {
      const r = await w.admin.query<{ id: string }>(
        `INSERT INTO chunk (org_id, content_version_id, content_id, text, locator)
         SELECT $1, $2, $3, t.text, jsonb_build_object('kind', 'pdf', 'page', t.n)
           FROM unnest($4::text[]) WITH ORDINALITY AS t(text, n) ORDER BY t.n RETURNING id`,
        [c.orgId, versionId, id, c.chunks],
      );
      chunkIds.push(...r.rows.map((x) => x.id));
    }
  }
  if (c.audience) {
    await insertTuples(
      w,
      c.orgId,
      c.audience.map((a) => ({
        objectType: 'content' as const,
        objectId: id,
        relation: 'viewer',
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        subjectRelation: a.subjectRelation,
      })),
    );
  }
  return { contentId: id, versionId, chunkIds };
}

/** Seeds one vector per distinct chunk text of the org, through platform_embedding_upsert (core function). */
export async function embedOrg(
  w: World,
  orgId: string,
  pinId: string = DEFAULT_PIN_ID,
  vectorOf: (text: string) => number[] = vectorFor,
): Promise<number> {
  const rows = await w.admin.query<{ text_sha256: Buffer; text: string }>(
    `SELECT DISTINCT ON (text_sha256) text_sha256, text FROM chunk WHERE org_id = $1 ORDER BY text_sha256`,
    [orgId],
  );
  let n = 0;
  for (let i = 0; i < rows.rows.length; i += 400) {
    const batch = rows.rows.slice(i, i + 400);
    const r = await w.platform.query<{ ok: boolean }>(
      `SELECT platform_embedding_upsert($1, t.h, $2, t.v::vector) AS ok FROM unnest($3::bytea[], $4::text[]) AS t(h, v)`,
      [
        orgId,
        pinId,
        batch.map((b) => b.text_sha256),
        batch.map((b) => `[${vectorOf(b.text).join(',')}]`),
      ],
    );
    n += r.rows.filter((x) => x.ok).length;
  }
  return n;
}

export async function sessionFor(w: World, userId: string, orgId: string | null): Promise<string> {
  const token = randomUUID() + randomUUID();
  await w.admin.query(
    `INSERT INTO platform.session (user_id, org_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
    [userId, orgId, sha256(token)],
  );
  return token;
}

// --- app -----------------------------------------------------------------------------------------------------

const stubStore = {} as unknown as ObjectStore;

export async function buildRetrievalApp(
  w: World,
  retrieval: AppDeps['retrieval'] = {},
  logSink?: { write(line: string): void },
): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: w.appUrl,
    APP_BASE_URL: 'http://localhost:3000',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_BUCKET: 'unused',
    S3_ACCESS_KEY: 'unused',
    S3_SECRET_KEY: 'unused-unused-unused',
    AUTH_RATE_LIMIT_MAX: '10000',
  });
  const app = await buildApp({
    config,
    pool: w.app,
    version: 'test',
    mailer: new FakeMailer(),
    store: stubStore,
    ...(logSink ? { logSink } : {}),
    retrieval,
  });
  await app.ready();
  return app;
}

export interface QueryResult {
  status: number;
  body: {
    items?: Array<{
      chunkId: string;
      contentId: string;
      versionId: string;
      snippet: string;
      locator: unknown;
    }>;
    retrievalMode?: string;
    degraded?: string | null;
    error?: { code: string };
  };
  raw: string;
}

export async function query(
  app: FastifyInstance,
  token: string,
  q: string,
  k?: number,
): Promise<QueryResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/retrieval/query',
    headers: { authorization: `Bearer ${token}` },
    payload: k === undefined ? { q } : { q, k },
  });
  return { status: res.statusCode, body: res.json() as QueryResult['body'], raw: res.body };
}

export { withTenant };

// --- engine access for suites that bypass the HTTP layer -------------------------------------------------

export function engineInput(
  orgId: string,
  userId: string,
  q: string,
  over: Partial<EngineInput> = {},
): EngineInput {
  return {
    orgId,
    userId,
    query: q,
    k: 10,
    now: new Date(),
    queryVector: vectorFor(q),
    degraded: null,
    embedderModel: PIN_MODEL,
    permittedIds: null,
    semaphore: new TrySemaphore(4),
    ...over,
  };
}

/** Runs the engine through the RLS-bound app role inside withTenant (RLS on). */
export async function runEngineApp(w: World, input: EngineInput): Promise<EngineResult> {
  return withTenant(
    w.app,
    { orgId: input.orgId, userId: input.userId },
    (client) => retrieve(client, input),
    { isolation: 'REPEATABLE READ' },
  );
}

/** Runs the engine through the superuser connection (RLS bypassed) with the same tenant settings. */
export async function runEngineAdmin(w: World, input: EngineInput): Promise<EngineResult> {
  await w.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await w.admin.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
      [input.orgId, input.userId],
    );
    const client = Object.assign(w.admin, {
      tenant: { orgId: input.orgId, userId: input.userId },
    }) as unknown as TenantClient;
    const r = await retrieve(client, input);
    await w.admin.query('COMMIT');
    return r;
  } catch (err) {
    await w.admin.query('ROLLBACK');
    throw err;
  } finally {
    Reflect.deleteProperty(w.admin, 'tenant');
  }
}

/** Seeded PRNG for the property tests (the seed is printed on failure). */
export function seededRandom(seed: number): () => number {
  return mulberry32(seed);
}

// --- document lifecycle through the core functions -----------------------------------------------------------

export interface LifecycleOrg {
  orgId: string;
  contributor: string;
}

export async function lifecycleCreate(
  w: World,
  org: LifecycleOrg,
  title: string,
  audienceOrgWide = true,
): Promise<string> {
  const id = randomUUID();
  await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
  await w.admin.query(
    `INSERT INTO content (org_id, id, kind, owner_id, title) VALUES ($1, $2, 'document', $3, $4)`,
    [org.orgId, id, org.contributor, title],
  );
  if (audienceOrgWide)
    await insertTuples(w, org.orgId, [
      {
        objectType: 'content',
        objectId: id,
        relation: 'viewer',
        subjectType: 'org',
        subjectId: org.orgId,
        subjectRelation: 'member',
      },
    ]);
  return id;
}

/** init + upload complete + claim + finish for one version; returns its id and the finish verdict. */
export async function lifecycleVersion(
  w: World,
  org: LifecycleOrg,
  contentId: string,
  chunks: Array<{ text: string; locator?: Record<string, unknown> }>,
): Promise<{ versionId: string; verdict: string }> {
  const v = await w.admin.query<{ id: string }>(
    `INSERT INTO content_version (org_id, content_id, status, original_key, original_name, original_size, mime_type, processing_step)
     VALUES ($1, $2, 'uploaded', 'k', 'f.pdf', 10, 'application/pdf', 'awaiting_upload') RETURNING id`,
    [org.orgId, contentId],
  );
  const versionId = v.rows[0]!.id;
  await withTenant(w.app, { orgId: org.orgId, userId: org.contributor }, async (c) => {
    await c.query('SELECT document_upload_complete($1, $2)', [contentId, versionId]);
  });
  const claim = await w.platform.query<{ a: string | null }>(
    'SELECT platform_document_claim($1, $2) AS a',
    [org.orgId, versionId],
  );
  const fin = await w.platform.query<{ r: string }>(
    'SELECT platform_document_finish($1, $2, $3, $4::jsonb) AS r',
    [
      org.orgId,
      versionId,
      claim.rows[0]!.a,
      JSON.stringify(
        chunks.map((c, i) => ({
          locator: c.locator ?? { kind: 'pdf', page: i + 1 },
          text: c.text,
          lang: 'en',
        })),
      ),
    ],
  );
  return { versionId, verdict: fin.rows[0]!.r };
}

export async function lifecyclePublish(
  w: World,
  org: LifecycleOrg,
  contentId: string,
): Promise<void> {
  await withTenant(w.app, { orgId: org.orgId, userId: org.contributor }, async (c) => {
    await c.query('SELECT content_publish($1, NULL, NULL)', [contentId]);
  });
}

export async function lifecycleRetract(
  w: World,
  org: LifecycleOrg,
  contentId: string,
): Promise<void> {
  await withTenant(w.app, { orgId: org.orgId, userId: org.contributor }, async (c) => {
    await c.query('SELECT content_retract($1)', [contentId]);
  });
}

export async function chunkIdsOfVersion(
  w: World,
  orgId: string,
  versionId: string,
): Promise<string[]> {
  const r = await w.admin.query<{ id: string }>(
    'SELECT id FROM chunk WHERE org_id = $1 AND content_version_id = $2 ORDER BY ordinal',
    [orgId, versionId],
  );
  return r.rows.map((x) => x.id);
}
