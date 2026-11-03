// SPDX-License-Identifier: AGPL-3.0-only
// Operational CLI used by the compose `migrate` service and the Helm pre-upgrade job.
import { lintSchema, runMigrations } from '@our-stream/db';

const cmd = process.argv[2];
const adminUrl = process.env['DATABASE_ADMIN_URL'];
if (!adminUrl) {
  console.error('DATABASE_ADMIN_URL is required');
  process.exit(2);
}
if (cmd === 'migrate') {
  const r = await runMigrations(adminUrl);
  console.log(
    `migrations applied: ${r.applied.join(', ') || 'none'} (already applied: ${r.skipped.length})`,
  );
  const findings = await lintSchema(adminUrl);
  if (findings.length > 0) {
    for (const f of findings) console.error(`schema lint: ${f.object}: ${f.problem}`);
    process.exit(1);
  }
  console.log('schema lint OK');
} else {
  console.error('usage: cli migrate');
  process.exit(2);
}
