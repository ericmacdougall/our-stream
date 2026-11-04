// SPDX-License-Identifier: AGPL-3.0-only
import { PgBoss, type Job } from 'pg-boss';
import pino from 'pino';
import { createPool } from '@our-stream/db';
import { createObjectStore, limitsFromEnv, s3ConfigFromEnv } from '@our-stream/pipeline';
import { createAsrProviderFromEnv, selectProvider } from '@our-stream/providers';
import { handlers, QUEUES, type JobContext } from './jobs.js';
import { drainOnce } from './outbox.js';

const log = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: ['*.password', '*.token', '*.secretKey', '*.accessKey'],
});
const tenantUrl = process.env['DATABASE_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL']; // never the admin role (code-inspection F3)
if (!tenantUrl || !platformUrl) {
  log.error('DATABASE_URL and DATABASE_PLATFORM_URL are required');
  process.exit(2);
}

// Deployment-wide provider policy (ADR-0008): self-host only unless explicitly relaxed. Per-org
// policies arrive with M2's provider UI; until then the deployment policy applies to every org.
const policy = {
  selfHostOnly: (process.env['PROVIDER_SELF_HOST_ONLY'] ?? 'true') !== 'false',
  requireZdr: (process.env['PROVIDER_REQUIRE_ZDR'] ?? 'true') !== 'false',
};
const asr = selectProvider(policy, [createAsrProviderFromEnv()], 'asr');
const limits = limitsFromEnv();
const store = createObjectStore(s3ConfigFromEnv());

const boss = new PgBoss({ connectionString: platformUrl, schema: 'pgboss' });
boss.on('error', (err: Error) => log.error({ err }, 'pg-boss error'));
await boss.start();

const ctx: JobContext = {
  tenantPool: createPool(tenantUrl),
  platformPool: createPool(platformUrl, { max: 4 }),
  queue: { send: (name, data, options) => boss.send(name, data, options) },
  store,
  asr,
  limits,
  log,
  now: () => new Date(),
};

// stately + singletonKey: at most one queued and one active job per version / per transition instant,
// so outbox replays never double-run work (ADR-0003 "singletonKey = version_id:job").
await boss.createQueue(QUEUES.mediaProcess, {
  policy: 'stately',
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: Math.ceil(limits.transcodeTimeoutMs / 1000) * 2 + 600,
});
await boss.createQueue(QUEUES.contentTransition, {
  policy: 'stately',
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
});
await boss.createQueue(QUEUES.outboxDrain, { policy: 'short', retryLimit: 0 });
await boss.createQueue(QUEUES.tenantPing);

const concurrency: Record<string, number> = {
  [QUEUES.mediaProcess]: Number(process.env['MEDIA_CONCURRENCY'] ?? '1'),
};
for (const [name, handler] of Object.entries(handlers)) {
  const n = concurrency[name] ?? 1;
  for (let i = 0; i < n; i += 1) {
    await boss.work(name, { batchSize: 1 }, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) {
        await handler(job.data, ctx);
      }
    });
  }
}
// Belt and braces: the cron keeps draining if the in-process timer dies with a replica.
await boss.schedule(QUEUES.outboxDrain, '* * * * *', {}, { singletonKey: 'outbox' });

const drainIntervalMs = Number(process.env['OUTBOX_DRAIN_INTERVAL_MS'] ?? '5000');
let draining = false;
const drainTimer = setInterval(() => {
  if (draining) return;
  draining = true;
  drainOnce(ctx)
    .catch((err: Error) => log.error({ err }, 'outbox drain failed'))
    .finally(() => {
      draining = false;
    });
}, drainIntervalMs);

log.info(
  {
    queues: Object.keys(handlers),
    asr: asr.descriptor.id,
    policy,
    drainIntervalMs,
    limits: { threads: limits.threads, maxInputBytes: limits.maxInputBytes },
  },
  'worker started',
);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(drainTimer);
  await boss.stop({ graceful: true, timeout: 30_000 });
  await ctx.tenantPool.end();
  await ctx.platformPool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('unhandledRejection', (err) => {
  log.error({ err }, 'unhandled rejection');
});
