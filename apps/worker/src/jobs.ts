// SPDX-License-Identifier: AGPL-3.0-only
// Job registry. Every tenant job carries org_id and runs inside withTenant (ADR-0001 §1c).
// Platform jobs run under the platform role and reach tenant rows only through the platform_* definer
// functions of migrations 0002/0003 with an explicit org id; the worker never holds a tenant context.
import type pg from 'pg';
import { withTenant } from '@our-stream/db';
import type { Mailer } from '@our-stream/notifications';
import type { ObjectStore, PipelineLimits } from '@our-stream/pipeline';
import type { AsrProvider } from '@our-stream/providers';
import { z } from 'zod';
import { notifyDigest } from './digest.js';
import { engagementRetention, searchPrune, searchReindex } from './maintenance.js';
import { outboxDrain } from './outbox.js';
import { mediaProcess } from './media.js';
import { contentTransition } from './transition.js';
import { documentProcess } from './documents/process.js';
import { embedReconcile, embedVersion, type EmbedRuntime } from './documents/embed.js';
import { embedPin } from './documents/pin.js';
import type { ParserClient } from '@our-stream/documents';

export const TenantJob = z.object({ orgId: z.uuid() });

export interface Logger {
  info: (o: object, msg?: string) => void;
  warn: (o: object, msg?: string) => void;
  error: (o: object, msg?: string) => void;
}

/** The subset of pg-boss the handlers use, so tests can record sends. */
export interface JobQueue {
  send(
    name: string,
    data: object,
    options: { singletonKey: string; startAfter?: Date; retentionSeconds?: number },
  ): Promise<string | null>;
}

export interface JobContext {
  tenantPool: pg.Pool;
  platformPool: pg.Pool;
  queue: JobQueue;
  store: ObjectStore;
  asr: AsrProvider;
  /** Parser sandbox client (document.process); absent where documents are not configured. */
  parser?: ParserClient;
  /** Embedding providers and policy (embed.* jobs); absent where documents are not configured. */
  embed?: EmbedRuntime;
  limits: PipelineLimits;
  /** Email channel (ADR-0005); a LoggingMailer when SMTP_URL is unset. */
  mailer: Mailer;
  /** Public web origin used for links in digests. */
  appBaseUrl: string;
  log: Logger;
  now: () => Date;
}

/** pg-boss retry metadata for the job being handled (absent in unit tests that call a handler directly). */
export interface JobMeta {
  retryCount: number;
  retryLimit: number;
}

export type Handler = (data: unknown, ctx: JobContext, meta?: JobMeta) => Promise<void>;

/** Example tenant job proving the tenant context contract. */
export const tenantPing: Handler = async (data, ctx) => {
  const { orgId } = TenantJob.parse(data);
  await withTenant(ctx.tenantPool, { orgId, userId: null }, async (client) => {
    const r = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM content');
    ctx.log.info({ orgId, content: r.rows[0]?.n ?? 0 }, 'tenant ping');
  });
};

export const QUEUES = {
  outboxDrain: 'platform.outbox.drain',
  mediaProcess: 'media.process',
  contentTransition: 'content.transition',
  tenantPing: 'tenant.ping',
  notifyDigest: 'notify.digest',
  engagementRetention: 'engagement.retention',
  searchPrune: 'search.prune',
  searchReindex: 'search.reindex',
  documentProcess: 'document.process',
  embedVersion: 'embed.version',
  embedReconcile: 'embed.reconcile',
  embedPin: 'embed.pin',
} as const;

export const handlers: Record<string, Handler> = {
  [QUEUES.outboxDrain]: outboxDrain,
  [QUEUES.mediaProcess]: mediaProcess,
  [QUEUES.contentTransition]: contentTransition,
  [QUEUES.tenantPing]: tenantPing,
  [QUEUES.notifyDigest]: notifyDigest,
  [QUEUES.engagementRetention]: engagementRetention,
  [QUEUES.searchPrune]: searchPrune,
  [QUEUES.searchReindex]: searchReindex,
  [QUEUES.documentProcess]: documentProcess,
  [QUEUES.embedVersion]: embedVersion,
  [QUEUES.embedReconcile]: embedReconcile,
  [QUEUES.embedPin]: embedPin,
};
