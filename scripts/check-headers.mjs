// SPDX-License-Identifier: AGPL-3.0-only
// Verifies that every source file carries the SPDX header required by its directory's license
// (REUSE.toml). apps/mobile is Apache-2.0, packages/contracts is dual-licensed, everything else AGPL.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const skipDirs = new Set([
  'node_modules',
  'dist',
  '.next',
  '.expo',
  '.turbo',
  'coverage',
  '.git',
  'generated',
]);
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql', '.yml', '.yaml', '.css']);
const skipFiles = new Set(['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'next-env.d.ts']);

function expectedFor(rel) {
  if (rel.startsWith(`apps${sep}mobile${sep}`)) return 'SPDX-License-Identifier: Apache-2.0';
  if (rel.startsWith(`packages${sep}contracts${sep}`))
    return 'SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0';
  return 'SPDX-License-Identifier: AGPL-3.0-only';
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const failures = [];
let checked = 0;
for (const file of walk(root)) {
  const rel = relative(root, file);
  const base = rel.split(sep).pop();
  if (skipFiles.has(base)) continue;
  const ext = rel.slice(rel.lastIndexOf('.'));
  if (!exts.has(ext)) continue;
  if (base.endsWith('.json')) continue;
  checked += 1;
  const head = readFileSync(file, 'utf8').slice(0, 400);
  const expected = expectedFor(rel);
  if (!head.includes(expected)) failures.push(`${rel}: missing "${expected}"`);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error(`\n${failures.length} file(s) missing SPDX headers (checked ${checked}).`);
  process.exit(1);
}
console.log(`SPDX headers OK (${checked} files checked).`);
