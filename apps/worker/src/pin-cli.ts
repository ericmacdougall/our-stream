// SPDX-License-Identifier: AGPL-3.0-only
// Operator and post-migrate entry for the embedding pins (see docs/documents.md "Embedding pins").
//   ensure            for every pin that is not retired: create its HNSW index with CREATE INDEX CONCURRENTLY
//                     IF NOT EXISTS (an INVALID leftover is dropped and rebuilt), then write readiness.
//                     Idempotent; the compose `pin-index` service and the Helm pin-index Job run it after
//                     migrate. Needs DATABASE_ADMIN_URL (DDL) and DATABASE_PLATFORM_URL.
//   register <model>  register a shadow pin (1024 dimensions) and print its id (platform role only).
//   status            print the pins and their readiness rows.
// Filling, readiness and the switch are worker jobs (queue embed.pin) so they run with the worker's
// providers and policy; this CLI never embeds anything.
import pg from 'pg';
import { ensurePinIndex, reportPinReadiness } from '@our-stream/db';

const [cmd, arg] = process.argv.slice(2);
const adminUrl = process.env['DATABASE_ADMIN_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL'];

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

if (cmd === 'ensure') {
  if (!adminUrl || !platformUrl) {
    console.error('DATABASE_ADMIN_URL and DATABASE_PLATFORM_URL are required');
    process.exit(2);
  }
  const pins = await withClient(adminUrl, async (c) => {
    const r = await c.query<{ id: string; state: string }>(
      "SELECT id, state FROM platform.embedding_pin WHERE state <> 'retired' ORDER BY state, id",
    );
    return r.rows;
  });
  const reports = [];
  for (const p of pins) {
    const idx = await ensurePinIndex(adminUrl, p.id);
    const ready = await reportPinReadiness(platformUrl, p.id, idx.valid);
    reports.push({ state: p.state, ...idx, ...ready });
  }
  console.log(JSON.stringify({ pins: reports }, null, 2));
  if (reports.some((r) => !r.valid)) process.exit(1);
} else if (cmd === 'register') {
  if (!platformUrl || !arg) {
    console.error('usage: pin-cli register <model>   (DATABASE_PLATFORM_URL required)');
    process.exit(2);
  }
  const id = await withClient(platformUrl, async (c) => {
    const r = await c.query<{ id: string }>(
      'SELECT platform_embedding_pin_register($1, 1024) AS id',
      [arg],
    );
    return r.rows[0]?.id;
  });
  console.log(id);
} else if (cmd === 'status') {
  if (!adminUrl) {
    console.error('DATABASE_ADMIN_URL is required');
    process.exit(2);
  }
  const rows = await withClient(adminUrl, async (c) => {
    const r = await c.query(
      `SELECT p.id, p.model, p.dims, p.state, r.index_valid, r.coverage_complete, r.checked_at
         FROM platform.embedding_pin p LEFT JOIN platform.embedding_pin_ready r ON r.pin_id = p.id ORDER BY p.state, p.id`,
    );
    return r.rows;
  });
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.error('usage: pin-cli <ensure|register <model>|status>');
  process.exit(2);
}
