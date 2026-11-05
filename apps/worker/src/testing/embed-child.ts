// SPDX-License-Identifier: AGPL-3.0-only
// Child process for the kill-mid-re-embed test: embeds one version slowly (small batches with a delay) so the
// parent can SIGKILL it part-way. Env: DATABASE_PLATFORM_URL, ORG_ID, VERSION_ID.
import { createPool } from '@our-stream/db';
import { createFakeEmbed } from '@our-stream/providers';
import type { JobContext } from '../jobs.js';
import { activePin, embedVersion } from '../documents/embed.js';

const slow = createFakeEmbed();
const provider = {
  ...slow,
  async embed(i: Parameters<typeof slow.embed>[0]) {
    await new Promise((r) => setTimeout(r, 400));
    return slow.embed(i);
  },
};
const pool = createPool(process.env['DATABASE_PLATFORM_URL']!, { max: 2 });
const ctx = {
  platformPool: pool,
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  embed: { policy: { selfHostOnly: true, requireZdr: true }, providers: [provider], batchSize: 2 },
} as unknown as JobContext;
console.log(`pin ${(await activePin(ctx)).id}`);
await embedVersion({ orgId: process.env['ORG_ID'], versionId: process.env['VERSION_ID'] }, ctx);
console.log('done');
await pool.end();
