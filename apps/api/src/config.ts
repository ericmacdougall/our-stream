// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// Values that ship in docker-compose for local evaluation. Production refuses them (fail fast).
export const DEV_DEFAULTS = {
  SESSION_SECRET: 'dev-only-session-secret-change-me-0123456789',
  MEDIA_HMAC_SECRET: 'dev-only-media-secret-change-me-0123456789',
  S3_SECRET_KEY: 'ourstream-dev-secret-only',
} as const;

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

  // Object storage (S3 API; SeaweedFS in compose). Path-style addressing is the self-host default.
  S3_ENDPOINT: z.url().default('http://localhost:8333'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('ourstream'),
  S3_ACCESS_KEY: z.string().min(1).default('ourstream-dev'),
  S3_SECRET_KEY: z.string().min(1).default(DEV_DEFAULTS.S3_SECRET_KEY),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Transactional mail. Unset: magic links and invites are logged (never printed with the token) and
  // not delivered; password sign-in keeps working (roadmap M1a).
  SMTP_URL: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(3).default('our-stream <no-reply@localhost>'),

  // Session cookie/bearer secrets. SESSION_SECRET keys the CSRF token; MEDIA_HMAC_SECRET keys the
  // short-lived media token for native players (ADR-0003).
  SESSION_SECRET: z.string().min(32).default(DEV_DEFAULTS.SESSION_SECRET),
  MEDIA_HMAC_SECRET: z.string().min(32).default(DEV_DEFAULTS.MEDIA_HMAC_SECRET),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  INVITE_LINK_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(14),
  MEDIA_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(3600),
  // Auth routes (signup, login, magic link request/consume) share a stricter per-IP limit.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    const bad: string[] = [];
    for (const [name, value] of Object.entries(DEV_DEFAULTS)) {
      if (cfg[name as keyof typeof DEV_DEFAULTS] === value) bad.push(name);
    }
    if (cfg.SESSION_SECRET.startsWith('dev-only')) bad.push('SESSION_SECRET');
    if (cfg.MEDIA_HMAC_SECRET.startsWith('dev-only')) bad.push('MEDIA_HMAC_SECRET');
    if (cfg.SESSION_SECRET === cfg.MEDIA_HMAC_SECRET)
      bad.push('MEDIA_HMAC_SECRET (equals SESSION_SECRET)');
    if (bad.length > 0) {
      throw new Error(
        `invalid configuration: development default secrets are not allowed in production: ${[...new Set(bad)].join(', ')}`,
      );
    }
    if (!cfg.APP_BASE_URL.startsWith('https://'))
      throw new Error('invalid configuration: APP_BASE_URL must be https in production');
  }
  return cfg;
}
