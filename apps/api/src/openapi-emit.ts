// SPDX-License-Identifier: AGPL-3.0-only
// Emits the OpenAPI document without a database so typed clients can be generated in CI.
import { writeFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const out = process.argv[2] ?? 'openapi.json';
const config = loadConfig({
  ...process.env,
  DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://unused',
});
const app = await buildApp({ config, pool: null, version: '0.0.0' });
await app.ready();
writeFileSync(out, JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
console.log(`wrote ${out}`);
