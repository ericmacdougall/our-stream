// SPDX-License-Identifier: AGPL-3.0-only
// media.process against a scripted database and object store. The pipeline's own tools (ffmpeg) are
// exercised in the integration test; here the store's download fails so the failure path is covered
// without media, and a successful pipeline is simulated by an unreadable but "present" original.
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { InputTooLargeError, limitsFromEnv, type ObjectStore } from '@our-stream/pipeline';
import { createFakeAsr } from '@our-stream/providers';
import { derivedPrefix, mediaProcess, MediaJobError } from './media.js';
import type { JobContext } from './jobs.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONTENT = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const job = { orgId: ORG, contentId: CONTENT, versionId: VERSION };

function fakeDb(brief: Record<string, unknown> | null) {
  const updates: unknown[][] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('platform_version_brief')) return { rows: brief ? [brief] : [] };
    if (sql.includes('platform_version_update')) {
      updates.push(params);
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
  return { pool: { query } as unknown as pg.Pool, updates };
}

function store(overrides: Partial<ObjectStore>): ObjectStore {
  const unused = async () => {
    throw new Error('unexpected store call');
  };
  return {
    download: unused,
    uploadDir: unused,
    list: unused,
    deletePrefix: unused,
    deleteKeys: unused,
    putObject: unused,
    getObject: unused,
    ensureBucket: unused,
    ...overrides,
  };
}

function ctx(pool: pg.Pool, s: ObjectStore): JobContext {
  return {
    tenantPool: pool,
    platformPool: pool,
    queue: { send: async () => null },
    store: s,
    asr: createFakeAsr(),
    limits: { ...limitsFromEnv({}), tmpRoot: null },
    mailer: { send: async () => undefined },
    appBaseUrl: 'http://localhost:3000',
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(),
  };
}

const brief = (extra: Record<string, unknown> = {}) => ({
  content_id: CONTENT,
  status: 'uploaded',
  original_key: `orgs/${ORG}/content/${CONTENT}/versions/${VERSION}/original/abc`,
  mime_type: 'video/mp4',
  assets: {},
  language: 'en',
  ...extra,
});

describe('mediaProcess', () => {
  it('derives the storage prefix from the job ids only', () => {
    expect(derivedPrefix(job)).toBe(`orgs/${ORG}/content/${CONTENT}/versions/${VERSION}/derived`);
  });

  it('drops a job whose version is not found under the org/content without writing anything', async () => {
    const db = fakeDb(null);
    await mediaProcess(job, ctx(db.pool, store({})));
    expect(db.updates).toEqual([]);
    const other = fakeDb(brief({ content_id: '99999999-9999-4999-8999-999999999999' }));
    await mediaProcess(job, ctx(other.pool, store({})));
    expect(other.updates).toEqual([]);
  });

  it('skips retracted and superseded versions', async () => {
    for (const status of ['retracted', 'superseded']) {
      const db = fakeDb(brief({ status }));
      await mediaProcess(job, ctx(db.pool, store({})));
      expect(db.updates).toEqual([]);
    }
  });

  it('marks a version without an original as failed and rethrows for retry', async () => {
    const db = fakeDb(brief({ original_key: null }));
    await expect(mediaProcess(job, ctx(db.pool, store({})))).rejects.toThrow(MediaJobError);
    expect(db.updates).toEqual([
      [ORG, VERSION, 'failed', 'brief', 'original upload missing', null, null, null],
    ]);
  });

  it('records processing steps, then failed with a redacted message when the download fails', async () => {
    const db = fakeDb(brief());
    const s = store({
      download: async (key) => {
        throw new InputTooLargeError(5_000_000_000, 4_294_967_296);
        void key;
      },
    });
    await expect(mediaProcess(job, ctx(db.pool, s))).rejects.toThrow(/input exceeds/);
    expect(db.updates[0]).toEqual([ORG, VERSION, 'processing', 'download', null, null, null, null]);
    const last = db.updates[db.updates.length - 1]!;
    expect(last.slice(0, 5)).toEqual([
      ORG,
      VERSION,
      'failed',
      'download',
      'download: input exceeds the maximum size (5000000000 > 4294967296 bytes)',
    ]);
  });

  it('never persists a path when a tool error carries one', async () => {
    const db = fakeDb(brief());
    const s = store({
      download: async (_key, dest) => {
        throw new Error(`EACCES: cannot write ${dest}`);
      },
    });
    await expect(mediaProcess(job, ctx(db.pool, s))).rejects.toThrow();
    const last = db.updates[db.updates.length - 1]!;
    expect(last[2]).toBe('failed');
    expect(String(last[4])).toContain('<path>');
    expect(String(last[4])).not.toMatch(/ourstream-media-/);
  });

  it('validates the job payload before any database access', async () => {
    const db = fakeDb(brief());
    await expect(mediaProcess({ orgId: ORG }, ctx(db.pool, store({})))).rejects.toThrow();
    expect(db.updates).toEqual([]);
  });
});
