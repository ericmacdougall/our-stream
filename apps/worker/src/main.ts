// SPDX-License-Identifier: AGPL-3.0-only
import { ensureBossSchema } from './boss-bootstrap.js';
import { PgBoss, type JobWithMetadata } from 'pg-boss';
import pino from 'pino';
import { assertPgvectorVersion, createPool } from '@our-stream/db';
import { createSmtpMailer, LoggingMailer } from '@our-stream/notifications';
import { createObjectStore, limitsFromEnv, s3ConfigFromEnv } from '@our-stream/pipeline';
import {
  createAsrProviderFromEnv,
  createEmbedProviderFromEnv,
  selectProvider,
  type EmbedProvider,
} from '@our-stream/providers';
import { ParserClient } from '@our-stream/documents';
import { handlers, QUEUES, type JobContext } from './jobs.js';
import { startHealthServer, type WorkerHealthState } from './health.js';
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

// Embedding providers (ADR-0008): the pinned default, plus an optional shadow-pin model for a same-dimension
// swap. The policy router is applied per call in documents/embed.ts with one candidate per pin (no fallback).
const embedProviders: EmbedProvider[] = [createEmbedProviderFromEnv(process.env, 'EMBED')];
if (process.env['EMBED_SHADOW_PROVIDER'])
  embedProviders.push(createEmbedProviderFromEnv(process.env, 'EMBED_SHADOW'));
if (
  process.env['NODE_ENV'] === 'production' &&
  embedProviders.some((p) => p.descriptor.id === 'embed-fake') &&
  process.env['EMBED_ALLOW_FAKE_IN_PRODUCTION'] !== 'true'
) {
  log.error(
    'the fake embedder is not semantic and is refused in production; set EMBED_PROVIDER=qwen-http',
  );
  process.exit(2);
}
const parser = new ParserClient({
  slotDir: process.env['PARSER_SLOT_DIR'] ?? '/parser-io/slot',
  ctlDir: process.env['PARSER_CTL_DIR'] ?? '/parser-io/ctl',
  heartbeatTtlMs: Number(process.env['PARSER_HEARTBEAT_TTL_MS'] ?? '15000'),
});
const store = createObjectStore(s3ConfigFromEnv());

// pgvector 0.8.0 or later (iterative index scan) is required by retrieval; fail closed below it.
{
  const checkPool = createPool(platformUrl, { max: 1 });
  try {
    const v = await assertPgvectorVersion(checkPool);
    log.info({ pgvector: v }, 'pgvector version check');
  } catch (err) {
    log.error({ err: (err as Error).message }, 'pgvector check failed; refusing to start');
    process.exit(2);
  } finally {
    await checkPool.end();
  }
}

const bossSchema = 'pgboss';
// Install pg-boss objects as the schema-owning platform role (no CREATE on the database), then start
// with migrate: false so pg-boss never issues CREATE SCHEMA itself.
{
  const bootstrapPool = createPool(platformUrl, { max: 1 });
  const outcome = await ensureBossSchema(bootstrapPool, bossSchema);
  await bootstrapPool.end();
  log.info({ outcome }, 'pg-boss schema bootstrap');
}
const drainIntervalMs = Number(process.env['OUTBOX_DRAIN_INTERVAL_MS'] ?? '5000');
// Readiness for probes (Helm/compose): loopback by default, HOST honoured like the API.
const health: WorkerHealthState = {
  startedAt: new Date(),
  bossStarted: false,
  lastDrainAt: null,
  lastDrainOk: null,
  drainIntervalMs,
};
const healthServer = startHealthServer(health, {
  host: process.env['HOST'] ?? '127.0.0.1',
  port: Number(process.env['WORKER_HEALTH_PORT'] ?? '4001'),
  now: () => new Date(),
});

const boss = new PgBoss({ connectionString: platformUrl, schema: bossSchema, migrate: false });
boss.on('error', (err: Error) => log.error({ err }, 'pg-boss error'));
await boss.start();
health.bossStarted = true;

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
  parser,
  embed: { policy, providers: embedProviders },
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
// Document parsing waits for the single sandbox slot and may take the full parser wall limit; a refused claim
// is acknowledged, an unavailable sandbox is retried and then ends the version failed (documents/process.ts).
await boss.createQueue(QUEUES.documentProcess, {
  policy: 'stately',
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 1800,
});
await boss.createQueue(QUEUES.embedVersion, {
  policy: 'stately',
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
});
await boss.createQueue(QUEUES.embedReconcile, { policy: 'short', retryLimit: 1, retryDelay: 300 });
// Pin fill, readiness and switch are operator-started and long-running; never retried automatically.
await boss.createQueue(QUEUES.embedPin, {
  policy: 'stately',
  retryLimit: 0,
  expireInSeconds: 6 * 3600,
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
  // One parse at a time per worker process: the parser has a single slot.
  [QUEUES.documentProcess]: 1,
};
for (const [name, handler] of Object.entries(handlers)) {
  const n = concurrency[name] ?? 1;
  for (let i = 0; i < n; i += 1) {
    await boss.work(
      name,
      { batchSize: 1, includeMetadata: true },
      async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) {
          await handler(job.data, ctx, { retryCount: job.retryCount, retryLimit: job.retryLimit });
        }
      },
    );
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
// Embedding reconciliation: garbage-collect unreferenced vectors, embed what is missing (parses that lost a
// vector to a concurrent collection, clip chunk backfill) and log per-org readiness.
await boss.schedule(
  QUEUES.embedReconcile,
  process.env['EMBED_RECONCILE_CRON'] ?? '*/10 * * * *',
  {},
  { singletonKey: 'embed-reconcile' },
);
await boss.schedule(
  QUEUES.searchPrune,
  process.env['SEARCH_PRUNE_CRON'] ?? '0 4 * * *',
  {},
  { singletonKey: 'search-prune' },
);

let draining = false;
const drainTimer = setInterval(() => {
  if (draining) return;
  draining = true;
  drainOnce(ctx)
    .then(() => {
      health.lastDrainAt = new Date();
      health.lastDrainOk = true;
    })
    .catch((err: Error) => {
      health.lastDrainAt = new Date();
      health.lastDrainOk = false;
      log.error({ err }, 'outbox drain failed');
    })
    .finally(() => {
      draining = false;
    });
}, drainIntervalMs);

log.info(
  {
    queues: Object.keys(handlers),
    asr: asr.descriptor.id,
    embed: embedProviders.map((p) => `${p.descriptor.id}:${p.model}`),
    mailer: smtpUrl ? 'smtp' : 'logging',
    policy,
    drainIntervalMs,
    healthPort: Number(process.env['WORKER_HEALTH_PORT'] ?? '4001'),
    limits: { threads: limits.threads, maxInputBytes: limits.maxInputBytes },
  },
  'worker started',
);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(drainTimer);
  healthServer.close();
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
