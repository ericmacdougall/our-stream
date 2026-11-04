// SPDX-License-Identifier: AGPL-3.0-only
import { PgBoss, type Job } from 'pg-boss';
import pino from 'pino';
import { createPool } from '@our-stream/db';
import { handlers, type JobContext } from './jobs.js';

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info', redact: ['*.password', '*.token'] });
const tenantUrl = process.env['DATABASE_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL']; // never the admin role (code-inspection F3)
if (!tenantUrl || !platformUrl) {
  log.error('DATABASE_URL and DATABASE_PLATFORM_URL are required');
  process.exit(2);
}

const boss = new PgBoss({ connectionString: platformUrl, schema: 'pgboss' });
boss.on('error', (err: Error) => log.error({ err }, 'pg-boss error'));
await boss.start();

const ctx: JobContext = {
  tenantPool: createPool(tenantUrl),
  platformPool: createPool(platformUrl, { max: 4 }),
  log,
};

for (const [name, handler] of Object.entries(handlers)) {
  await boss.createQueue(name);
  await boss.work(name, { batchSize: 1 }, async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      await handler(job.data, ctx);
    }
  });
}
await boss.schedule('platform.outbox.drain', '* * * * *', {}, { singletonKey: 'outbox' });
log.info({ queues: Object.keys(handlers) }, 'worker started');

const shutdown = async () => {
  await boss.stop({ graceful: true, timeout: 10_000 });
  await ctx.tenantPool.end();
  await ctx.platformPool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
