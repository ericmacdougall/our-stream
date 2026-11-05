// SPDX-License-Identifier: AGPL-3.0-only
// The app Dockerfiles copy workspace packages one by one (pnpm deploy needs the exact set). This fails the
// build when an app gains a workspace dependency the Dockerfile does not copy, which otherwise only shows
// up as a failed image build (M1b: the worker gained @our-stream/notifications).
import { readFileSync } from 'node:fs';

const apps = ['api', 'worker', 'web', 'parser'];
const failures = [];

function workspaceDeps(pkgPath, seen = new Set()) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!name.startsWith('@our-stream/')) continue;
    const dir = name.slice('@our-stream/'.length);
    if (seen.has(dir)) continue;
    seen.add(dir);
    workspaceDeps(`packages/${dir}/package.json`, seen);
  }
  return seen;
}

for (const app of apps) {
  const needed = workspaceDeps(`apps/${app}/package.json`);
  needed.add('config');
  const dockerfile = readFileSync(`infra/docker/${app}.Dockerfile`, 'utf8');
  const manifestCopies = new Set(
    [...dockerfile.matchAll(/^COPY packages\/([a-z-]+)\/package\.json /gm)].map((m) => m[1]),
  );
  const sourceCopies = new Set(
    [...dockerfile.matchAll(/^COPY packages\/([a-z-]+) packages\//gm)].map((m) => m[1]),
  );
  for (const dir of needed) {
    if (!manifestCopies.has(dir))
      failures.push(`infra/docker/${app}.Dockerfile: missing COPY packages/${dir}/package.json`);
    if (!sourceCopies.has(dir))
      failures.push(`infra/docker/${app}.Dockerfile: missing COPY packages/${dir} packages/${dir}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Dockerfile workspace copies OK (${apps.join(', ')}).`);
