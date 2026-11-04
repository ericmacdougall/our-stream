// SPDX-License-Identifier: AGPL-3.0-only
import { ensureBossSchema } from './boss-bootstrap.js';
import { PgBoss, type Job } from 'pg-boss';
import pino from 'pino';
import { createPool } from '@our-stream/db';
import { createSmtpMailer, LoggingMailer } from '@our-stream/notifications';
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

const bossSchema = 'pgboss';
// Install pg-boss objects as the schema-owning platform role (no CREATE on the database), then start
// with migrate: false so pg-boss never issues CREATE SCHEMA itself.
{
  const bootstrapPool = createPool(platformUrl, { max: 1 });
  const outcome = await ensureBossSchema(bootstrapPool, bossSchema);
  await bootstrapPool.end();
  log.info({ outcome }, 'pg-boss schema bootstrap');
}
const boss = new PgBoss({ connectionString: platformUrl, schema: bossSchema, migrate: false });
boss.on('error', (err: Error) => log.error({ err }, 'pg-boss error'));
await boss.start();

// Email channel (ADR-0005): SMTP when configured, otherwise digests are logged as skipped.
const smtpUrl = process.env['SMTP_URL'];
const appBaseUrl = process.env['APP_BASE_URL'];
if (
  smtpUrl &&
  (!appBaseUrl || (process.env['NODE_ENV'] === 'production' && !appBaseUrl.startsWith('https://')))
) {
  log.error(
    'SMTP_URL is set but APP_BASE_URL is missing or not https; digests would carry unusable links',
  );
  process.exit(2);
}
const mailer = smtpUrl
  ? createSmtpMailer(smtpUrl, process.env['MAIL_FROM'] ?? 'our-stream <no-reply@localhost>')
  : new LoggingMailer(log);

const ctx: JobContext = {
  tenantPool: createPool(tenantUrl),
  platformPool: createPool(platformUrl, { max: 4 }),
  queue: { send: (name, data, options) => boss.send(name, data, options) },
  store,
  asr,
  limits,
  mailer,
  appBaseUrl: appBaseUrl ?? 'http://localhost:3000',
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
// M1b scheduled jobs: singleton per run; a failed run is retried once, the next cron tick covers the rest.
await boss.createQueue(QUEUES.notifyDigest, { policy: 'short', retryLimit: 1, retryDelay: 300 });
await boss.createQueue(QUEUES.engagementRetention, {
  policy: 'short',
  retryLimit: 1,
  retryDelay: 300,
});
await boss.createQueue(QUEUES.searchPrune, { policy: 'short', retryLimit: 1, retryDelay: 300 });
await boss.createQueue(QUEUES.searchReindex, { policy: 'stately', retryLimit: 2, retryDelay: 60 });

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
// Daily digest (DIGEST_CRON, default 06:00 UTC), engagement retention and search hygiene.
await boss.schedule(
  QUEUES.notifyDigest,
  process.env['DIGEST_CRON'] ?? '0 6 * * *',
  {},
  { singletonKey: 'digest' },
);
await boss.schedule(
  QUEUES.engagementRetention,
  process.env['RETENTION_CRON'] ?? '30 3 * * *',
  {},
  { singletonKey: 'retention' },
);
await boss.schedule(
  QUEUES.searchPrune,
  process.env['SEARCH_PRUNE_CRON'] ?? '0 4 * * *',
  {},
  { singletonKey: 'search-prune' },
);

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
    mailer: smtpUrl ? 'smtp' : 'logging',
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
