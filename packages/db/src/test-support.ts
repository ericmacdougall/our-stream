// SPDX-License-Identifier: AGPL-3.0-only
// Helpers shared by the database integration suites (not exported from the package index). A suite that
// toggles deployment-global state (kill switch, flag record, hide record, embedding pins) runs in its own
// scratch database so parallel suites sharing DATABASE_ADMIN_URL are never disturbed.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, withTenant } from './tenant.js';

/** Same server and credentials, another database name. */
export function withDatabaseName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export interface Scratch {
  adminUrl: string;
  appUrl: string;
  platformUrl: string;
  name: string;
  drop: () => Promise<void>;
}

/** Creates an empty scratch database (extensions are created by migration 0001). */
export async function createScratchDatabase(
  adminUrl: string,
  appUrl: string,
  platformUrl: string,
  prefix: string,
): Promise<Scratch> {
  const name = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${name}`);
    await root.query(`GRANT CONNECT ON DATABASE ${name} TO ourstream_app, ourstream_platform`);
  } finally {
    await root.end();
  }
  return {
    name,
    adminUrl: withDatabaseName(adminUrl, name),
    appUrl: withDatabaseName(appUrl, name),
    platformUrl: withDatabaseName(platformUrl, name),
    drop: async () => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

export const sha256Nfc = (text: string): Buffer =>
  createHash('sha256').update(text.normalize('NFC'), 'utf8').digest();

export interface TestOrg {
  orgId: string;
  slug: string;
  owner: string;
  contributor: string;
  member: string;
}

export interface Harness {
  admin: pg.Client;
  app: pg.Pool;
  platform: pg.Pool;
  close: () => Promise<void>;
  seedOrg: (opts?: { documentsEnabled?: boolean | null }) => Promise<TestOrg>;
  /** Draft document with an org-wide audience tuple. */
  createDocument: (org: TestOrg, over?: { title?: string }) => Promise<string>;
  createClip: (org: TestOrg) => Promise<string>;
  /** Version row as upload init leaves it: uploaded, awaiting_upload. */
  initVersion: (org: TestOrg, contentId: string) => Promise<string>;
  /** App-role upload complete (document_upload_complete). */
  complete: (org: TestOrg, contentId: string, versionId: string) => Promise<number>;
  claim: (org: TestOrg, versionId: string) => Promise<string | null>;
  finish: (
    org: TestOrg,
    versionId: string,
    attempt: string | null,
    chunks: unknown,
  ) => Promise<string>;
  publish: (
    org: TestOrg,
    contentId: string,
    publishAt?: Date | null,
    expiresAt?: Date | null,
  ) => Promise<void>;
  retract: (org: TestOrg, contentId: string) => Promise<void>;
  version: (org: TestOrg, versionId: string) => Promise<VersionRow>;
  chunkCount: (org: TestOrg, versionId: string) => Promise<number>;
  currentVersionId: (org: TestOrg, contentId: string) => Promise<string | null>;
  events: (
    org: TestOrg,
    contentId: string,
    type: string,
  ) => Promise<Array<{ version_id: string | null; payload: Record<string, unknown> }>>;
}

export interface VersionRow {
  status: string;
  processing_step: string | null;
  processing_error: string | null;
  parse_attempt: string | null;
  completed_seq: string | null;
}

export const sampleChunks = (n = 3, tag = 'alpha') =>
  Array.from({ length: n }, (_, i) => ({
    locator: { kind: 'pdf', page: i + 1 },
    text: `${tag} paragraph ${i + 1} about the onboarding policy`,
    lang: 'en',
  }));

export async function makeHarness(
  adminUrl: string,
  appUrl: string,
  platformUrl: string,
): Promise<Harness> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const app = createPool(appUrl, { max: 6 });
  const platform = createPool(platformUrl, { max: 6 });
  const h: Harness = {
    admin,
    app,
    platform,
    close: async () => {
      await admin.end();
      await app.end();
      await platform.end();
    },
    seedOrg: async (opts = {}) => {
      const slug = `m2a-${randomUUID().slice(0, 8)}`;
      const orgId = randomUUID();
      const [owner, contributor, member] = [randomUUID(), randomUUID(), randomUUID()] as const;
      const settings =
        opts.documentsEnabled === null ? {} : { documents_enabled: opts.documentsEnabled ?? true };
      await admin.query(
        'INSERT INTO org (id, slug, name, settings) VALUES ($1, $2, $2, $3::jsonb)',
        [orgId, slug, JSON.stringify(settings)],
      );
      for (const [name, id, role] of [
        ['owner', owner, 'owner'],
        ['contributor', contributor, 'contributor'],
        ['member', member, 'member'],
      ] as const) {
        await admin.query(
          'INSERT INTO platform.user_account (id, email, email_normalized, display_name) VALUES ($1, $2, $2, $3)',
          [id, `${name}-${id.slice(0, 8)}@example.invalid`, name],
        );
        await admin.query(
          'INSERT INTO org_membership (org_id, user_id, role) VALUES ($1, $2, $3)',
          [orgId, id, role],
        );
      }
      return { orgId, slug, owner, contributor, member };
    },
    createDocument: async (org, over = {}) => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO content (org_id, id, kind, owner_id, title) VALUES ($1, $2, 'document', $3, $4)`,
        [org.orgId, id, org.contributor, over.title ?? `doc ${id.slice(0, 8)}`],
      );
      await admin.query(
        `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation)
         VALUES ($1, 'content', $2, 'viewer', 'org', $1, 'member')`,
        [org.orgId, id],
      );
      return id;
    },
    createClip: async (org) => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO content (org_id, id, kind, owner_id, title) VALUES ($1, $2, 'clip', $3, $4)`,
        [org.orgId, id, org.contributor, `clip ${id.slice(0, 8)}`],
      );
      await admin.query(
        `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation)
         VALUES ($1, 'content', $2, 'viewer', 'org', $1, 'member')`,
        [org.orgId, id],
      );
      return id;
    },
    initVersion: async (org, contentId) => {
      const r = await admin.query<{ id: string }>(
        `INSERT INTO content_version (org_id, content_id, status, original_key, original_name, original_size, mime_type, processing_step)
         VALUES ($1, $2, 'uploaded', 'k', 'f.pdf', 10, 'application/pdf', 'awaiting_upload') RETURNING id`,
        [org.orgId, contentId],
      );
      return r.rows[0]!.id;
    },
    complete: async (org, contentId, versionId) =>
      withTenant(app, { orgId: org.orgId, userId: org.contributor }, async (c) => {
        const r = await c.query<{ s: string }>(
          'SELECT document_upload_complete($1, $2)::text AS s',
          [contentId, versionId],
        );
        return Number(r.rows[0]!.s);
      }),
    claim: async (org, versionId) => {
      const r = await platform.query<{ a: string | null }>(
        'SELECT platform_document_claim($1, $2) AS a',
        [org.orgId, versionId],
      );
      return r.rows[0]!.a;
    },
    finish: async (org, versionId, attempt, chunks) => {
      const r = await platform.query<{ r: string }>(
        'SELECT platform_document_finish($1, $2, $3, $4::jsonb) AS r',
        [org.orgId, versionId, attempt, JSON.stringify(chunks)],
      );
      return r.rows[0]!.r;
    },
    publish: async (org, contentId, publishAt = null, expiresAt = null) => {
      await withTenant(app, { orgId: org.orgId, userId: org.contributor }, async (c) => {
        await c.query('SELECT content_publish($1, $2, $3)', [contentId, publishAt, expiresAt]);
      });
    },
    retract: async (org, contentId) => {
      await withTenant(app, { orgId: org.orgId, userId: org.contributor }, async (c) => {
        await c.query('SELECT content_retract($1)', [contentId]);
      });
    },
    version: async (org, versionId) => {
      const r = await admin.query<VersionRow>(
        `SELECT status::text, processing_step, processing_error, parse_attempt::text, completed_seq::text
           FROM content_version WHERE org_id = $1 AND id = $2`,
        [org.orgId, versionId],
      );
      return r.rows[0]!;
    },
    chunkCount: async (org, versionId) => {
      const r = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM chunk WHERE org_id = $1 AND content_version_id = $2',
        [org.orgId, versionId],
      );
      return r.rows[0]!.n;
    },
    currentVersionId: async (org, contentId) => {
      const r = await admin.query<{ v: string | null }>(
        'SELECT current_version_id AS v FROM content WHERE org_id = $1 AND id = $2',
        [org.orgId, contentId],
      );
      return r.rows[0]!.v;
    },
    events: async (org, contentId, type) => {
      const r = await admin.query<{ version_id: string | null; payload: Record<string, unknown> }>(
        'SELECT version_id, payload FROM platform.domain_event WHERE org_id = $1 AND subject_id = $2 AND type = $3 ORDER BY id',
        [org.orgId, contentId, type],
      );
      return r.rows;
    },
  };
  return h;
}

/** Polls pg_stat_activity until a backend with this pid waits on a lock. */
export async function waitForLockWait(
  admin: pg.Client,
  pid: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await admin.query<{ w: string | null }>(
      'SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    if (r.rows[0]?.w === 'Lock') return;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked on a lock`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

/** A 1024-dimension vector literal with a single non-zero component. */
export const unitVector = (i: number, dims = 1024): string => {
  const v = new Array<number>(dims).fill(0);
  v[i % dims] = 1;
  return `[${v.join(',')}]`;
};
