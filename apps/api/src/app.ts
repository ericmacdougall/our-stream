// SPDX-License-Identifier: AGPL-3.0-only
// Fastify application factory. Routes are registered with Zod schemas so the OpenAPI document is
// generated from the same definitions (ADR-0011). Personalised responses are private, no-store.
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

function parseTrustProxy(v: string): boolean | string {
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  return v;
}

export interface AppDeps {
  config: Config;
  pool: pg.Pool | null;
  version: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      // Redact anything that could carry credentials or content (risk R16).
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
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

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: [deps.config.APP_BASE_URL], credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
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
    const body: ErrorResponse = {
      error: {
        code: status >= 500 ? 'internal' : ((err as { code?: string }).code ?? 'bad_request'),
        message: status >= 500 ? 'internal error' : (err as Error).message,
        requestId: String(req.id),
      },
    };
    void reply.status(status).send(body);
  });

  app.get(
    '/health',
    { schema: { tags: ['system'], response: { 200: HealthResponse, 503: HealthResponse } } },
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
    { schema: { tags: ['system'], response: { 200: MetaResponse } } },
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

  app.get('/openapi.json', { schema: { hide: true } }, async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return app.swagger();
  });

  return app;
}
