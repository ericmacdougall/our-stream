// SPDX-License-Identifier: AGPL-3.0-only
import { createPool } from '@our-stream/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createS3Store } from './lib/storage.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const store = createS3Store(config);
const app = await buildApp({
  config,
  pool,
  store,
  version: process.env['npm_package_version'] ?? '0.0.0',
});

try {
  await store.ensureBucket();
} catch (err) {
  app.log.warn({ err }, 'object storage not reachable at startup; uploads and media will fail');
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
