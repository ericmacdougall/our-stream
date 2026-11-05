// SPDX-License-Identifier: AGPL-3.0-only
// Dependency license gate (ADR-0011): bundled dependencies must use an allow-listed license.
// AGPL-licensed services (Garage, MinIO) are deployed separately and never appear here.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
  // jszip (mammoth, exceljs) is dual-licensed; we elect the MIT terms.
  '(MIT OR GPL-3.0-or-later)',
]);
// Packages whose manifest declares a vague identifier but whose shipped LICENSE text was read and is
// allow-listed: duck@0.1.12 (mammoth) declares "BSD" and ships the BSD 2-clause text.
const reviewedPackages = new Set(['duck@0.1.12']);
const denied = /SSPL|BUSL|Elastic|FSL|RSAL|Commons-Clause|CC-BY-NC|Proprietary|UNLICENSED/i;

// Deployed services and models (compose and Helm) are not npm dependencies, so they are reviewed here: an image
// or model that is not in these tables fails the check until its licence has been read and recorded.
// Read 2026-11-04 from each project's repository licence file or model card.
const reviewedImages = {
  'pgvector/pgvector': 'PostgreSQL',
  'chrislusf/seaweedfs': 'Apache-2.0',
  'axllent/mailpit': 'MIT',
  caddy: 'Apache-2.0',
  'ghcr.io/ggml-org/whisper.cpp': 'MIT',
  'ghcr.io/huggingface/text-embeddings-inference': 'Apache-2.0',
};
const reviewedModels = { 'Qwen/Qwen3-Embedding-0.6B': 'Apache-2.0' };
const serviceProblems = [];
for (const file of ['infra/docker/docker-compose.yml', 'infra/helm/our-stream/values.yaml']) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/^\s*(?:image|imageName):\s*['"]?([^\s'"#@]+)/gm)) {
    const ref = m[1];
    if (ref.includes('${') || ref.startsWith('{{')) continue;
    if (/^(registry|repository)/.test(ref) || (!ref.includes('/') && !/^caddy:/.test(ref)))
      continue;
    const name = ref.replace(/:[^/]*$/, '');
    // Our own images are built from this repository (AGPL-3.0-only); the cnpg Postgres image is reviewed with the operator.
    if (/ericmacdougall\/our-stream/.test(name) || name === 'ghcr.io/cloudnative-pg/postgresql')
      continue;
    if (!reviewedImages[name]) serviceProblems.push(`REVIEW image ${name} (${file})`);
  }
  for (const m of text.matchAll(/(?:model-id'?,?\s*|model:\s*)['"]?(Qwen\/[A-Za-z0-9._-]+)/g))
    if (!reviewedModels[m[1]]) serviceProblems.push(`REVIEW model ${m[1]} (${file})`);
}
for (const needed of ['ghcr.io/huggingface/text-embeddings-inference']) {
  if (!readFileSync('infra/docker/docker-compose.yml', 'utf8').includes(needed))
    serviceProblems.push(`the embedding service image ${needed} is not named in the compose file`);
}
if (!readFileSync('infra/docker/docker-compose.yml', 'utf8').includes('Qwen/Qwen3-Embedding-0.6B'))
  serviceProblems.push(
    'the default embedding model Qwen/Qwen3-Embedding-0.6B is not named in the compose file',
  );
if (serviceProblems.length > 0) {
  console.error(serviceProblems.join('\n'));
  process.exit(1);
}

const raw = execSync('pnpm licenses list --json --prod', {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const data = JSON.parse(raw);
const problems = [];
for (const [license, pkgs] of Object.entries(data)) {
  const names = pkgs.map((p) => `${p.name}@${p.versions?.join('/') ?? p.version ?? ''}`);
  if (denied.test(license)) problems.push(`DENIED ${license}: ${names.join(', ')}`);
  else if (!allowed.has(license) && !names.every((n) => reviewedPackages.has(n)))
    problems.push(`REVIEW ${license}: ${names.join(', ')}`);
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(
  `Dependency licenses OK (${Object.keys(data).length} license identifiers; ${Object.keys(reviewedImages).length} service images and ${Object.keys(reviewedModels).length} model reviewed).`,
);
