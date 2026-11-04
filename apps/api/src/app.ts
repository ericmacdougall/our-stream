// SPDX-License-Identifier: AGPL-3.0-only
// Fastify application factory. Routes are registered with Zod schemas so the OpenAPI document is
// generated from the same definitions (ADR-0011). Personalised responses are private, no-store.
import { createHash } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type pg from 'pg';
import { HealthResponse, MetaResponse, type ErrorResponse } from '@our-stream/contracts';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { enforceCsrf, resolveAuth } from './lib/auth.js';
import { ApiError } from './lib/errors.js';
import { LoggingMailer, createSmtpMailer, type Mailer } from './lib/mailer.js';
import { createS3Store, type ObjectStore } from './lib/storage.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerContentRoutes } from './routes/content.js';
import { registerFeedRoutes } from './routes/feed.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerOrgRoutes } from './routes/org.js';

function parseTrustProxy(v: string): boolean | string {
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  return v;
}

export interface AppDeps {
  config: Config;
  /** null only for schema emission and unit tests; every route then answers 503. */
  pool: pg.Pool | null;
  version: string;
  mailer?: Mailer;
  store?: ObjectStore;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      // Redact anything that could carry credentials or content (risk R16).
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        'err.detail',
        'err.hint',
        'err.internalQuery',
        'err.where',
      ],
    },
    requestIdHeader: 'x-request-id',
    trustProxy: parseTrustProxy(deps.config.TRUST_PROXY),
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  // Body-less mutations (retract, read, logout) are commonly sent with a JSON content type and an
  // empty body; treat an empty JSON body as {} instead of rejecting the request.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(Object.assign(err as Error, { statusCode: 400 }), undefined);
    }
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: [deps.config.APP_BASE_URL],
    credentials: true,
    exposedHeaders: ['content-range', 'accept-ranges'],
  });
  await app.register(cookie);
  // Keyed by session when present so clients behind one proxy address (the web app's rewrite) do not
  // share a budget; anonymous traffic stays keyed by client IP (honoured X-Forwarded-For via TRUST_PROXY).
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const cookie = req.headers.cookie ?? '';
      const m = /(?:^|;\s*)os_session=([^;]+)/.exec(cookie);
      const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null;
      const cred = m?.[1] ?? bearer;
      return cred
        ? `s:${createHash('sha256').update(cred).digest('base64url').slice(0, 24)}`
        : `ip:${req.ip}`;
    },
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'our-stream API',
        version: deps.version,
        license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
      },
      components: {
        securitySchemes: {
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'os_session' },
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  // Every response that could be personalised is uncacheable by shared caches (ADR-0004).
  app.addHook('onSend', async (req, reply) => {
    if (!reply.getHeader('cache-control')) reply.header('cache-control', 'private, no-store');
    reply.header('vary', 'Cookie, Authorization');
  });

  app.setErrorHandler((err, req, reply) => {
    const status =
      typeof (err as { statusCode?: number }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) req.log.error({ err, requestId: req.id }, 'unhandled error');
    const rawCode = (err as { code?: string }).code;
    const body: ErrorResponse = {
      error: {
        code:
          status >= 500
            ? 'internal'
            : rawCode === 'FST_ERR_VALIDATION'
              ? 'validation'
              : (rawCode ?? 'bad_request'),
        message: status >= 500 ? 'internal error' : (err as Error).message,
        requestId: String(req.id),
      },
    };
    void reply.status(status).send(body);
  });

  const publicRoute = { public: true };
  app.get(
    '/health',
    {
      config: publicRoute,
      schema: { tags: ['system'], response: { 200: HealthResponse, 503: HealthResponse } },
    },
    async (_req, reply) => {
      let database: 'ok' | 'degraded' | 'down' = 'down';
      if (deps.pool) {
        try {
          await deps.pool.query('SELECT 1');
          database = 'ok';
        } catch {
          database = 'down';
        }
      }
      const body = { status: 'ok' as const, version: deps.version, checks: { database } };
      return reply.status(database === 'ok' ? 200 : 503).send(body);
    },
  );

  app.get(
    '/v1/meta',
    { config: publicRoute, schema: { tags: ['system'], response: { 200: MetaResponse } } },
    async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=300');
      return {
        name: 'our-stream' as const,
        version: deps.version,
        sourceUrl: `${deps.config.SOURCE_URL}/tree/${deps.config.GIT_COMMIT}`,
        commit: deps.config.GIT_COMMIT,
      };
    },
  );

  app.get('/openapi.json', { config: publicRoute, schema: { hide: true } }, async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return app.swagger();
  });

  // Authenticated surface. Session, membership and CSRF are resolved per request from the database.
  app.decorateRequest('auth', null);
  const pool = deps.pool;
  app.addHook('preHandler', async (req) => {
    if ((req.routeOptions.config as { public?: boolean }).public) return;
    if (!pool) throw new ApiError(503, 'unavailable', 'database not configured');
    req.auth = await resolveAuth(req, pool);
    enforceCsrf(req, deps.config);
  });

  const ctx: AppContext = {
    config: deps.config,
    pool: pool ?? (null as unknown as pg.Pool),
    mailer:
      deps.mailer ??
      (deps.config.SMTP_URL
        ? createSmtpMailer(deps.config.SMTP_URL, deps.config.MAIL_FROM)
        : new LoggingMailer(app.log)),
    store: deps.store ?? createS3Store(deps.config),
  };
  registerAuthRoutes(app, ctx);
  registerOrgRoutes(app, ctx);
  registerContentRoutes(app, ctx);
  registerFeedRoutes(app, ctx);
  registerMediaRoutes(app, ctx);

  return app;
}
