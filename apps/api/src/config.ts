// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  SOURCE_URL: z.url().default('https://github.com/ericmacdougall/our-stream'),
  GIT_COMMIT: z.string().default('unknown'),
  // Trust X-Forwarded-* only when a reverse proxy is in front (comma-separated hops/CIDRs, or 'true').
  TRUST_PROXY: z.string().default('false'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  return parsed.data;
}
