// SPDX-License-Identifier: AGPL-3.0-only
// Dependency license gate (ADR-0011): bundled dependencies must use an allow-listed license.
// AGPL-licensed services (Garage, MinIO) are deployed separately and never appear here.
import { execSync } from 'node:child_process';

const allowed = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'PostgreSQL',
  'MPL-2.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  // LGPL is compatible with AGPL-3.0; it appears only as prebuilt, dynamically linked native libraries (sharp/libvips via Next.js).
  'LGPL-3.0-or-later',
  'LGPL-2.1-or-later',
  'AGPL-3.0-only',
  '(MIT OR CC0-1.0)',
  'MIT AND Apache-2.0',
  '(MIT AND Apache-2.0)',
  '(MIT OR Apache-2.0)',
  '(Apache-2.0 OR MIT)',
  '(MIT AND Zlib)',
  '(BSD-3-Clause OR GPL-2.0)',
  '(MPL-2.0 OR Apache-2.0)',
  '(AFL-2.1 OR BSD-3-Clause)',
  '(WTFPL OR MIT)',
]);
const denied = /SSPL|BUSL|Elastic|FSL|RSAL|Commons-Clause|CC-BY-NC|Proprietary|UNLICENSED/i;

const raw = execSync('pnpm licenses list --json --prod', {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const data = JSON.parse(raw);
const problems = [];
for (const [license, pkgs] of Object.entries(data)) {
  const names = pkgs.map((p) => `${p.name}@${p.versions?.join('/') ?? p.version ?? ''}`);
  if (denied.test(license)) problems.push(`DENIED ${license}: ${names.join(', ')}`);
  else if (!allowed.has(license)) problems.push(`REVIEW ${license}: ${names.join(', ')}`);
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Dependency licenses OK (${Object.keys(data).length} license identifiers).`);
