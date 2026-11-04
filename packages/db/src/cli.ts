// SPDX-License-Identifier: AGPL-3.0-only
import { lintSchema } from './schema-lint.js';
import { runMigrations } from './migrate.js';

const cmd = process.argv[2];
const adminUrl = process.env['DATABASE_ADMIN_URL'];
if (!adminUrl) {
  console.error('DATABASE_ADMIN_URL is required');
  process.exit(2);
}

if (cmd === 'migrate') {
  const r = await runMigrations(adminUrl);
  console.log(`applied: ${r.applied.join(', ') || 'none'}; already applied: ${r.skipped.length}`);
} else if (cmd === 'schema-lint') {
  const findings = await lintSchema(adminUrl);
  if (findings.length > 0) {
    for (const f of findings) console.error(`${f.object}: ${f.problem}`);
    console.error(`${findings.length} schema lint finding(s)`);
    process.exit(1);
  }
  console.log('schema lint OK');
} else {
  console.error('usage: cli <migrate|schema-lint>');
  process.exit(2);
}
