// SPDX-License-Identifier: AGPL-3.0-only
// Bundles src/sw.ts into public/sw.js with esbuild. Kept out of the Next.js bundler on purpose so
// the worker builds identically under Turbopack and webpack (Serwist's Next plugin is webpack-only).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, 'src/sw.ts')],
  outfile: join(root, 'public/sw.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: process.env['NODE_ENV'] === 'production',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env['NODE_ENV'] ?? 'development') },
  legalComments: 'none',
  banner: {
    js: '// SPDX-License-Identifier: AGPL-3.0-only\n// Generated from src/sw.ts; do not edit.',
  },
  logLevel: 'warning',
});
