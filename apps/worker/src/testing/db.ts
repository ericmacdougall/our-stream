// SPDX-License-Identifier: AGPL-3.0-only
// Database helpers for the worker's document integration suites: a scratch database per suite (pins, flags and
// the kill switch are deployment-global state) and seeding through the admin role.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, withTenant } from '@our-stream/db';

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

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface Org {
  orgId: string;
  owner: string;
  contributor: string;
  member: string;
}

export interface Db {
  admin: pg.Client;
  app: pg.Pool;
  platform: pg.Pool;
  close: () => Promise<void>;
  seedOrg: (documentsEnabled?: boolean) => Promise<Org>;
  setFlag: (org: Org, enabled: boolean) => Promise<void>;
  createContent: (org: Org, kind: 'document' | 'clip') => Promise<string>;
  /** Version as upload init leaves it (awaiting upload), with a stored mime type. */
  initVersion: (org: Org, contentId: string, mime?: string) => Promise<string>;
  /** App-role document_upload_complete. */
  complete: (org: Org, contentId: string, versionId: string) => Promise<void>;
  publish: (org: Org, contentId: string) => Promise<void>;
  version: (
    org: Org,
    versionId: string,
  ) => Promise<{
    status: string;
    processing_step: string | null;
    processing_error: string | null;
    parse_attempt: string | null;
  }>;
  chunkTexts: (org: Org, versionId: string) => Promise<string[]>;
  embeddingCount: (org: Org, pinId?: string) => Promise<number>;
  q: <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export async function makeDb(adminUrl: string, appUrl: string, platformUrl: string): Promise<Db> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const app = createPool(appUrl, { max: 4 });
  const platform = createPool(platformUrl, { max: 6 });
  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await admin.query<T>(sql, params)).rows;
  const db: Db = {
    admin,
    app,
    platform,
    q,
    close: async () => {
      await admin.end();
      await app.end();
      await platform.end();
    },
    seedOrg: async (documentsEnabled = true) => {
      const orgId = randomUUID();
      const [owner, contributor, member] = [randomUUID(), randomUUID(), randomUUID()] as const;
      await admin.query(
        'INSERT INTO org (id, slug, name, settings) VALUES ($1, $2, $2, $3::jsonb)',
        [orgId, `w-${orgId.slice(0, 8)}`, JSON.stringify({ documents_enabled: documentsEnabled })],
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
      return { orgId, owner, contributor, member };
    },
    setFlag: async (org, enabled) => {
      await admin.query(
        `UPDATE org SET settings = jsonb_set(settings, '{documents_enabled}', $2::jsonb) WHERE id = $1`,
        [org.orgId, JSON.stringify(enabled)],
      );
    },
    createContent: async (org, kind) => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO content (org_id, id, kind, owner_id, title) VALUES ($1, $2, $3, $4, $5)`,
        [org.orgId, id, kind, org.contributor, `${kind} ${id.slice(0, 8)}`],
      );
      await admin.query(
        `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation)
         VALUES ($1, 'content', $2, 'viewer', 'org', $1, 'member')`,
        [org.orgId, id],
      );
      return id;
    },
    initVersion: async (org, contentId, mime = DOCX_MIME) => {
      const r = await admin.query<{ id: string }>(
        `INSERT INTO content_version (org_id, content_id, status, original_key, original_name, original_size, mime_type, processing_step)
         VALUES ($1, $2, 'uploaded', $3, 'f.docx', 10, $4, 'awaiting_upload') RETURNING id`,
        [
          org.orgId,
          contentId,
          `orgs/${org.orgId}/content/${contentId}/original-${randomUUID()}`,
          mime,
        ],
      );
      return r.rows[0]!.id;
    },
    complete: async (org, contentId, versionId) => {
      await withTenant(app, { orgId: org.orgId, userId: org.contributor }, async (c) => {
        await c.query('SELECT document_upload_complete($1, $2)', [contentId, versionId]);
      });
    },
    publish: async (org, contentId) => {
      await withTenant(app, { orgId: org.orgId, userId: org.contributor }, async (c) => {
        await c.query('SELECT content_publish($1, NULL, NULL)', [contentId]);
      });
    },
    version: async (org, versionId) => {
      const r = await admin.query(
        `SELECT status::text, processing_step, processing_error, parse_attempt::text FROM content_version WHERE org_id = $1 AND id = $2`,
        [org.orgId, versionId],
      );
      return r.rows[0];
    },
    chunkTexts: async (org, versionId) => {
      const r = await admin.query<{ text: string }>(
        'SELECT text FROM chunk WHERE org_id = $1 AND content_version_id = $2 ORDER BY ordinal',
        [org.orgId, versionId],
      );
      return r.rows.map((x) => x.text);
    },
    embeddingCount: async (org, pinId) => {
      const r = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM embedding WHERE org_id = $1 AND ($2::uuid IS NULL OR pin_id = $2)`,
        [org.orgId, pinId ?? null],
      );
      return r.rows[0]!.n;
    },
  };
  return db;
}
