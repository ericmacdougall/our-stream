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
  limits: PipelineLimits;
  /** Email channel (ADR-0005); a LoggingMailer when SMTP_URL is unset. */
  mailer: Mailer;
  /** Public web origin used for links in digests. */
  appBaseUrl: string;
  log: Logger;
  now: () => Date;
}

export type Handler = (data: unknown, ctx: JobContext) => Promise<void>;

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
};
