// SPDX-License-Identifier: AGPL-3.0-only
// document.process: pipeline order is attestation, then claim, then parse, then finish.
//   brief -> (refusals before the claim end the version `failed` through platform_document_fail once pg-boss
//   retries are exhausted) -> attest the sandbox -> platform_document_claim (NULL means refused: acknowledge,
//   no retry) -> download -> parse in the sandbox -> chunk -> platform_document_finish -> enqueue embedding.
// Every write after the claim carries the attempt id the claim returned, so a late or replaced worker is
// fenced by the database. The parser's output is untrusted and validated by ParserClient.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputTooLargeError } from '@our-stream/pipeline';
import {
  DEFAULT_LIMITS,
  ParserOutputInvalidError,
  ParserTimeoutError,
  ParserUnavailableError,
  chunkBlocks,
  type RefusalCode,
} from '@our-stream/documents';
import { z } from 'zod';
import type { Handler, JobContext } from '../jobs.js';
import { QUEUES } from '../jobs.js';
import { kindFromMime } from './kinds.js';

export const DocumentJob = z.object({ orgId: z.uuid(), contentId: z.uuid(), versionId: z.uuid() });
export type DocumentJob = z.infer<typeof DocumentJob>;

interface VersionBrief {
  content_id: string;
  status: 'uploaded' | 'processing' | 'current' | 'superseded' | 'retracted' | 'failed';
  original_key: string | null;
  mime_type: string | null;
  language: string | null;
}

/** Primary language subtag of the content language, as the chunk column wants it (default `en`). */
export function chunkLang(language: string | null): string {
  const sub = (language ?? '').split(/[-_]/)[0]?.toLowerCase() ?? '';
  return /^[a-z]{2,3}$/.test(sub) ? sub : 'en';
}

const FAIL_PREFIX = 'parse_failed:';

export const documentProcess: Handler = async (data, ctx, meta) => {
  const job = DocumentJob.parse(data);
  const log = { orgId: job.orgId, contentId: job.contentId, versionId: job.versionId };
  const parser = ctx.parser;
  if (!parser) throw new Error('document.process: no parser client configured');
  const exhausted = meta ? meta.retryCount >= meta.retryLimit : false;

  const briefRes = await ctx.platformPool.query<VersionBrief>(
    'SELECT content_id, status, original_key, mime_type, language FROM platform_version_brief($1, $2)',
    [job.orgId, job.versionId],
  );
  const brief = briefRes.rows[0];
  if (!brief || brief.content_id !== job.contentId) {
    ctx.log.warn(log, 'document.process: version not found for org/content; dropping job');
    return;
  }
  if (brief.status !== 'uploaded' && brief.status !== 'processing') {
    ctx.log.info(
      { ...log, status: brief.status },
      'document.process: version no longer processable',
    );
    return;
  }
  const fail = async (reason: string) => {
    const failed = await ctx.platformPool.query<{ ok: boolean }>(
      'SELECT platform_document_fail($1, $2, $3) AS ok',
      [job.orgId, job.versionId, reason],
    );
    ctx.log.warn(
      { ...log, reason, failed: failed.rows[0]?.ok === true },
      'document.process: version failed before claim',
    );
  };

  // Refusals that no retry can fix end the version before a claim exists.
  const kind = kindFromMime(brief.mime_type);
  if (!brief.original_key) return fail(`${FAIL_PREFIX}original_missing`);
  if (!kind) return fail(`${FAIL_PREFIX}unsupported`);

  // 1. attestation
  try {
    await parser.attest();
  } catch (err) {
    if (err instanceof ParserUnavailableError) {
      ctx.log.warn(
        { ...log, reason: err.reason, exhausted },
        'document.process: parser sandbox not attested',
      );
      if (exhausted) await fail(`${FAIL_PREFIX}parser_unavailable`);
      throw err; // pg-boss retries with backoff; the version stays untouched until then
    }
    throw err;
  }

  // 2. claim: NULL is a refusal (current, failed, retracted, awaiting upload, not a document): acknowledge.
  const claim = await ctx.platformPool.query<{ attempt: string | null }>(
    'SELECT platform_document_claim($1, $2) AS attempt',
    [job.orgId, job.versionId],
  );
  const attempt = claim.rows[0]?.attempt ?? null;
  if (!attempt) {
    ctx.log.info(log, 'document.process: claim refused; acknowledged without retry');
    return;
  }
  const step = async (name: string, error: string | null = null): Promise<boolean> => {
    const r = await ctx.platformPool.query<{ r: string }>(
      'SELECT platform_document_step($1, $2, $3, $4, $5) AS r',
      [job.orgId, job.versionId, attempt, name, error],
    );
    return r.rows[0]?.r === 'ok';
  };

  const work = await mkdtemp(join(ctx.limits.tmpRoot ?? tmpdir(), 'doc-'));
  try {
    if (!(await step('downloading'))) return;
    const file = join(work, 'original');
    try {
      await ctx.store.download(brief.original_key, file, DEFAULT_LIMITS.maxFileBytes);
    } catch (err) {
      if (err instanceof InputTooLargeError) {
        await step('download', `${FAIL_PREFIX}file_too_large`);
        return;
      }
      throw err; // storage trouble: retry (the next claim replaces this attempt)
    }

    if (!(await step('parsing'))) return;
    let result;
    try {
      result = await parser.run(file, { kind, mime: brief.mime_type });
    } catch (err) {
      // A busy slot and any error that is not a verdict about this file (a filesystem or storage fault) are
      // retried: the next claim replaces this attempt. Only a timeout or a contract breach fails the version.
      if (!(err instanceof ParserTimeoutError) && !(err instanceof ParserOutputInvalidError))
        throw err;
      const code = err instanceof ParserTimeoutError ? 'timeout' : 'output_invalid';
      ctx.log.error(
        { ...log, code, detail: err instanceof ParserOutputInvalidError ? err.reason : undefined },
        'document.process: parser failed',
      );
      await step('parse', `${FAIL_PREFIX}${code}`);
      return;
    }
    if (!result.ok) {
      const code: RefusalCode = result.code;
      ctx.log.info({ ...log, code }, 'document.process: parser refused the file');
      await step('parse', `${FAIL_PREFIX}${code}`);
      return;
    }

    if (!(await step('chunking'))) return;
    const chunks = chunkBlocks(result.blocks, { lang: chunkLang(brief.language) });
    if (chunks.length === 0) {
      await step('chunking', `${FAIL_PREFIX}no_text`);
      return;
    }
    const fin = await ctx.platformPool.query<{ r: string }>(
      'SELECT platform_document_finish($1, $2, $3, $4::jsonb) AS r',
      [job.orgId, job.versionId, attempt, JSON.stringify(chunks)],
    );
    const outcome = fin.rows[0]?.r;
    ctx.log.info({ ...log, outcome, chunks: chunks.length, kind }, 'document.process done');
    if (outcome === 'ok') {
      await ctx.queue.send(
        QUEUES.embedVersion,
        { orgId: job.orgId, versionId: job.versionId },
        { singletonKey: `embed:${job.versionId}` },
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

export type { JobContext };
