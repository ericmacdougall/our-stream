// SPDX-License-Identifier: AGPL-3.0-only
// document.process against a scripted platform pool and parser: pipeline order (attest, claim, parse,
// finish), refusals before the claim, retry exhaustion, an acknowledged refused claim, fencing by attempt id,
// well-formed text and the neutral failure codes.
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { InputTooLargeError } from '@our-stream/pipeline';
import {
  ParserOutputInvalidError,
  ParserTimeoutError,
  ParserUnavailableError,
  type ParserClient,
  type ResultFile,
} from '@our-stream/documents';
import type { JobContext } from '../jobs.js';
import { chunkLang, documentProcess } from './process.js';
import { kindFromMime } from './kinds.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONTENT = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = '44444444-4444-4444-8444-444444444444';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const job = { orgId: ORG, contentId: CONTENT, versionId: VERSION };

interface Script {
  brief?: Record<string, unknown> | null;
  claim?: string | null;
  /** step names for which platform_document_step answers 'stale' */
  staleAt?: string[];
  finish?: string;
  attest?: () => Promise<unknown>;
  run?: () => Promise<ResultFile>;
  download?: () => Promise<unknown>;
}

function harness(s: Script = {}) {
  const calls: string[] = [];
  const args: Record<string, unknown[][]> = {};
  const sent: { name: string; data: unknown; options: unknown }[] = [];
  const logs: unknown[] = [];
  const fnOf = (sql: string) => /(platform_[a-z_]+)\(/.exec(sql)?.[1] ?? 'other';
  const query = async (sql: string, params: unknown[] = []) => {
    const fn = fnOf(sql);
    calls.push(
      fn === 'platform_document_step'
        ? `step:${String(params[3])}${params[4] ? `!${String(params[4])}` : ''}`
        : fn,
    );
    (args[fn] ??= []).push(params);
    const rows: Record<string, unknown>[] = (() => {
      switch (fn) {
        case 'platform_version_brief':
          return s.brief === null
            ? []
            : [
                {
                  content_id: CONTENT,
                  status: 'uploaded',
                  original_key: 'orgs/o/content/c/versions/v/original',
                  mime_type: DOCX,
                  language: null,
                  ...s.brief,
                },
              ];
        case 'platform_document_claim':
          return [{ attempt: s.claim === undefined ? ATTEMPT : s.claim }];
        case 'platform_document_step':
          return [{ r: s.staleAt?.includes(String(params[3])) ? 'stale' : 'ok' }];
        case 'platform_document_finish':
          return [{ r: s.finish ?? 'ok' }];
        case 'platform_document_fail':
          return [{ ok: true }];
        default:
          return [];
      }
    })();
    return { rows, rowCount: rows.length } as unknown as pg.QueryResult;
  };
  const ctx = {
    platformPool: { query } as unknown as pg.Pool,
    tenantPool: {} as pg.Pool,
    queue: {
      send: async (name: string, data: object, options: object) => {
        sent.push({ name, data, options });
        return 'id';
      },
    },
    store: {
      download: async (_k: string, dest: string) => {
        calls.push('download');
        if (s.download) await s.download();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(dest, 'bytes');
        return { size: 5 };
      },
    },
    limits: { tmpRoot: null },
    parser: {
      attest: async () => {
        calls.push('attest');
        return s.attest ? s.attest() : { nonce: 'n' };
      },
      run: async () => {
        calls.push('run');
        return s.run
          ? s.run()
          : {
              v: 1,
              jobId: 'a'.repeat(32),
              ok: true,
              kind: 'docx',
              blocks: [{ text: 'hello world', locator: {} }],
            };
      },
    } as unknown as ParserClient,
    log: {
      info: (o: object, m?: string) => logs.push({ o, m }),
      warn: (o: object, m?: string) => logs.push({ o, m }),
      error: (o: object, m?: string) => logs.push({ o, m }),
    },
    now: () => new Date(),
  } as unknown as JobContext;
  return { ctx, calls, args, sent, logs };
}

describe('document.process', () => {
  it('runs attest, claim, parse, finish in that order and enqueues the embedding job', async () => {
    const h = harness();
    await documentProcess(job, h.ctx);
    expect(h.calls).toEqual([
      'platform_version_brief',
      'attest',
      'platform_document_claim',
      'step:downloading',
      'download',
      'step:parsing',
      'run',
      'step:chunking',
      'platform_document_finish',
    ]);
    expect(h.args['platform_document_finish']?.[0]?.slice(0, 3)).toEqual([ORG, VERSION, ATTEMPT]);
    const chunks = JSON.parse(String(h.args['platform_document_finish']?.[0]?.[3]));
    expect(chunks).toEqual([{ locator: {}, text: 'hello world', lang: 'en' }]);
    expect(h.sent).toEqual([
      {
        name: 'embed.version',
        data: { orgId: ORG, versionId: VERSION },
        options: { singletonKey: `embed:${VERSION}` },
      },
    ]);
  });

  it('never claims when the sandbox is not attested; a retry is requested', async () => {
    const h = harness({
      attest: async () => Promise.reject(new ParserUnavailableError('heartbeat_stale')),
    });
    await expect(
      documentProcess(job, h.ctx, { retryCount: 0, retryLimit: 3 }),
    ).rejects.toBeInstanceOf(ParserUnavailableError);
    expect(h.calls).toEqual(['platform_version_brief', 'attest']);
  });

  it('after the last retry an unattested sandbox ends the version failed through platform_document_fail', async () => {
    const h = harness({
      attest: async () => Promise.reject(new ParserUnavailableError('challenge_timeout')),
    });
    await expect(
      documentProcess(job, h.ctx, { retryCount: 3, retryLimit: 3 }),
    ).rejects.toBeInstanceOf(ParserUnavailableError);
    expect(h.calls).toEqual(['platform_version_brief', 'attest', 'platform_document_fail']);
    expect(h.args['platform_document_fail']?.[0]).toEqual([
      ORG,
      VERSION,
      'parse_failed:parser_unavailable',
    ]);
    expect(h.calls).not.toContain('platform_document_claim');
  });

  it('a refused claim (NULL) is acknowledged without retry and without parsing', async () => {
    const h = harness({ claim: null });
    await expect(documentProcess(job, h.ctx)).resolves.toBeUndefined();
    expect(h.calls).toEqual(['platform_version_brief', 'attest', 'platform_document_claim']);
    expect(h.sent).toEqual([]);
  });

  it('drops a job for a version of another content, and acknowledges a terminal version', async () => {
    let h = harness({ brief: { content_id: '99999999-9999-4999-8999-999999999999' } });
    await documentProcess(job, h.ctx);
    expect(h.calls).toEqual(['platform_version_brief']);
    for (const status of ['current', 'failed', 'retracted', 'superseded']) {
      h = harness({ brief: { status } });
      await documentProcess(job, h.ctx);
      expect(h.calls, status).toEqual(['platform_version_brief']);
    }
  });

  it('refusals before the claim fail the version at once: no original, unsupported or ambiguous type', async () => {
    for (const brief of [
      { original_key: null },
      { mime_type: 'application/x-msdownload' },
      { mime_type: 'text/plain' },
      { mime_type: null },
    ]) {
      const h = harness({ brief });
      await documentProcess(job, h.ctx);
      expect(h.calls, JSON.stringify(brief)).toEqual([
        'platform_version_brief',
        'platform_document_fail',
      ]);
    }
    expect(kindFromMime('text/csv; charset=utf-8')).toBe('csv');
    expect(kindFromMime('text/markdown')).toBe('md');
    expect(kindFromMime('application/pdf')).toBe('pdf');
  });

  it('a parser refusal fails the version with the neutral code and writes no chunks', async () => {
    const h = harness({
      run: async () => ({ v: 1, jobId: 'a'.repeat(32), ok: false, code: 'macro_enabled' }),
    });
    await documentProcess(job, h.ctx);
    expect(h.calls.slice(-2)).toEqual(['run', 'step:parse!parse_failed:macro_enabled']);
    expect(h.calls).not.toContain('platform_document_finish');
    expect(h.sent).toEqual([]);
  });

  it('timeout, invalid output and a download over the limit are neutral failures, not retries', async () => {
    let h = harness({ run: async () => Promise.reject(new ParserTimeoutError()) });
    await documentProcess(job, h.ctx);
    expect(h.calls.at(-1)).toBe('step:parse!parse_failed:timeout');
    h = harness({ run: async () => Promise.reject(new ParserOutputInvalidError('symlink')) });
    await documentProcess(job, h.ctx);
    expect(h.calls.at(-1)).toBe('step:parse!parse_failed:output_invalid');
    h = harness({ download: async () => Promise.reject(new InputTooLargeError(200, 100)) });
    await documentProcess(job, h.ctx);
    expect(h.calls.at(-1)).toBe('step:download!parse_failed:file_too_large');
  });

  it('a busy slot is retried (not failed)', async () => {
    const h = harness({ run: async () => Promise.reject(new ParserUnavailableError('busy')) });
    await expect(documentProcess(job, h.ctx)).rejects.toBeInstanceOf(ParserUnavailableError);
    expect(h.calls.some((c) => c.includes('!'))).toBe(false);
  });

  it('stops quietly when a step answers stale (replaced, retracted or superseded)', async () => {
    for (const at of ['downloading', 'parsing', 'chunking']) {
      const h = harness({ staleAt: [at] });
      await documentProcess(job, h.ctx);
      expect(h.calls, at).not.toContain('platform_document_finish');
      expect(h.sent).toEqual([]);
    }
  });

  it('zero chunks fail as no_text before finish is called', async () => {
    const h = harness({
      run: async () => ({
        v: 1,
        jobId: 'a'.repeat(32),
        ok: true,
        kind: 'docx',
        blocks: [{ text: '   ', locator: {} }],
      }),
    });
    await documentProcess(job, h.ctx);
    expect(h.calls.at(-1)).toBe('step:chunking!parse_failed:no_text');
  });

  it('NEG-1: lone surrogates are made well-formed before they reach jsonb', async () => {
    const h = harness({
      run: async () => ({
        v: 1,
        jobId: 'a'.repeat(32),
        ok: true,
        kind: 'docx',
        blocks: [{ text: 'bad \ud800 and \udc00 pair', locator: {} }],
      }),
    });
    await documentProcess(job, h.ctx);
    const payload = String(h.args['platform_document_finish']?.[0]?.[3]);
    expect(payload).not.toMatch(/\\ud800|\\udc00/i);
    expect(JSON.parse(payload)[0].text).toBe('bad � and � pair');
    expect(new TextEncoder().encode(payload).length).toBeGreaterThan(0);
  });

  it('an unexpected storage error is retried (rethrown) and the version is left to the next claim', async () => {
    const h = harness({ download: async () => Promise.reject(new Error('socket hang up')) });
    await expect(documentProcess(job, h.ctx)).rejects.toThrow('socket hang up');
    expect(h.calls).not.toContain('platform_document_finish');
  });

  it('chunkLang keeps the primary subtag and defaults to en', () => {
    expect(chunkLang('fr-CA')).toBe('fr');
    expect(chunkLang(null)).toBe('en');
    expect(chunkLang('x-klingon-long')).toBe('en');
  });
});
