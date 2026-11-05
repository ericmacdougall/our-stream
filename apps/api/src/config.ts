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
  // Browser origins allowed to PUT upload parts directly to object storage (comma separated); defaults to
  // APP_BASE_URL plus its localhost/127.0.0.1 twin for development.
  S3_CORS_ORIGINS: z.string().default(''),
  SOURCE_URL: z.url().default('https://github.com/ericmacdougall/our-stream'),
  GIT_COMMIT: z.string().default('unknown'),
  // Trust X-Forwarded-* only when a reverse proxy is in front (comma-separated hops/CIDRs, or 'true').
  TRUST_PROXY: z.string().default('false'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // Object storage (S3 API; SeaweedFS in compose). Path-style addressing is the self-host default.
  S3_ENDPOINT: z.url().default('http://localhost:8333'),
  // Browser-reachable storage endpoint used only to presign upload-part URLs (compose's internal
  // http://storage:8333 cannot be resolved by a browser); defaults to S3_ENDPOINT. The infra owner routes
  // it through the edge proxy; the bucket CORS allow-list is unaffected (it lists browser origins).
  S3_PUBLIC_ENDPOINT: z.url().optional(),
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
  // Auth routes (signup, login, magic link request/consume) share a stricter per-IP limit. Per-IP
  // budgets only hold when TRUST_PROXY matches hops that append their peer to X-Forwarded-For
  // (docs/development.md, "Proxies and rate limits"); the per-email budget holds regardless.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  AUTH_EMAIL_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  // Per minute. Unauthenticated requests by client address; authenticated by validated session id;
  // media by the user id of a verified media token.
  IP_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  SESSION_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  MEDIA_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(1200),
  // M1b write budgets (per minute, by validated session id): likes/engagement/pins/tags/settings share
  // WRITE; comments, search and share have their own so a flood on one cannot starve the others and the
  // share oracle (ADR-0002 accepts telling the sharer) stays slow and audited.
  WRITE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
  COMMENT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
  SHARE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),

  // M2a documents (owner-chosen defaults, not user-sourced; docs/documents.md). Limits are per process.
  // Value written into org.settings.documents_enabled when an org is created (compose sets true for
  // self-host; every other install defaults to off). An org without the key is off (fail closed).
  DOCUMENTS_ENABLED_DEFAULT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DOCUMENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(100 * 1024 * 1024),
  DOCUMENT_UPLOADS_PER_USER_HOUR: z.coerce.number().int().min(1).default(20),
  DOCUMENT_ORG_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(5 * 1024 * 1024 * 1024),
  /** Keyword search over documents and retrieval share this per-user budget (60 per minute). */
  DOCUMENT_QUERY_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
  /** Concurrent original downloads streamed by this process, overall and per user. */
  DOCUMENT_DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).default(32),
  DOCUMENT_DOWNLOAD_CONCURRENCY_PER_USER: z.coerce.number().int().min(1).default(4),
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
