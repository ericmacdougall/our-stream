// SPDX-License-Identifier: AGPL-3.0-only
// POST /v1/retrieval/query (M2a AC-4, AC-5). Member session; keyword + vector legs fused; every returned
// chunk belongs to the current published version and passes the reader-visible predicate inside the request's
// REPEATABLE READ snapshot (one captured :now), then the independent reference check. See
// docs/documents.md "Retrieval" for the semantics; the engine lives in lib/retrieval/.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { RetrievalQuery, RetrievalResponse } from '@our-stream/contracts';
import { withTenant, type EpochReads, type WithTenantOptions } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { requireMember } from '../lib/auth.js';
import { ApiError, forbidden } from '../lib/errors.js';
import { FixedWindowLimiter } from '../lib/limits.js';
import {
  CACHE_BUCKET_MS,
  EMBED_TIMEOUT_MS,
  FALLBACK_CONCURRENCY,
  RETRIEVAL_RATE_LIMIT_PER_MINUTE,
} from '../lib/retrieval/constants.js';
import { embedWithTimeout, type QueryEmbedder } from '../lib/retrieval/embedder.js';
import {
  retrieve,
  type EngineHooks,
  type EngineVariant,
  type Tuning,
} from '../lib/retrieval/engine.js';
import { bucketOf, PermittedIdCache } from '../lib/retrieval/permitted-cache.js';
import { TrySemaphore } from '../lib/retrieval/semaphore.js';

const security = [{ cookieAuth: [] }, { bearerAuth: [] }];

/**
 * Dependencies of the route. Production passes none: no embedder means keyword-only until the worker slice's
 * `embed` capability is wired in here (integration point: an adapter over selectProvider('embed') that
 * throws EmbedRefusedError on a policy refusal). Everything else is a test seam.
 */
export interface RetrievalOptions {
  embedder?: QueryEmbedder | null;
  now?: () => Date;
  cache?: PermittedIdCache;
  semaphore?: TrySemaphore;
  limiter?: FixedWindowLimiter;
  embedTimeoutMs?: number;
  tuning?: Partial<Tuning>;
  /** Test only: a deliberately broken engine variant. */
  variant?: EngineVariant;
  hooks?: EngineHooks;
  tenantHooks?: WithTenantOptions['testHooks'];
}

/** Zero-width and format characters that make visually identical queries differ. */
const ZERO_WIDTH = new RegExp('[\u200B-\u200D\u2060\uFEFF]', 'g');
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/** NFC, zero-width removed, controls to spaces, trimmed. Length is bounded by request validation. */
export function normalizeRetrievalQuery(q: string): string {
  return q.normalize('NFC').replace(ZERO_WIDTH, '').replace(CONTROLS, ' ').trim();
}

export function registerRetrievalRoutes(
  fastify: FastifyInstance,
  ctx: AppContext,
  options: RetrievalOptions = {},
): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const cache = options.cache ?? new PermittedIdCache();
  const semaphore = options.semaphore ?? new TrySemaphore(FALLBACK_CONCURRENCY);
  const limiter =
    options.limiter ??
    new FixedWindowLimiter({ max: RETRIEVAL_RATE_LIMIT_PER_MINUTE, windowMs: 60_000 });
  const embedder = options.embedder ?? null;
  const clock = options.now ?? (() => new Date());

  app.post(
    '/v1/retrieval/query',
    {
      schema: {
        tags: ['retrieval'],
        body: RetrievalQuery,
        response: { 200: RetrievalResponse },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      if (!limiter.allow(auth.userId)) throw new ApiError(429, 'rate_limited', 'too many requests');
      const q = normalizeRetrievalQuery(req.body.q);
      if (q.length === 0)
        return { items: [], retrievalMode: 'keyword_only' as const, degraded: null };
      // Embedded BEFORE the tenant transaction opens (a slow embedder must not hold a snapshot or a
      // connection); a timeout, refusal or error degrades to keyword-only.
      const embedded = await embedWithTimeout(
        embedder,
        q,
        options.embedTimeoutMs ?? EMBED_TIMEOUT_MS,
      );
      const now = clock();
      let toCache: { key: Parameters<PermittedIdCache['put']>[0]; ids: string[] } | null = null;
      const result = await withTenant(
        ctx.pool,
        { orgId: auth.orgId, userId: auth.userId },
        async (client, epochs: EpochReads | undefined) => {
          if (!epochs?.active) throw forbidden('not_member', 'membership is not active');
          const key = {
            orgId: auth.orgId,
            userId: auth.userId,
            authzEpoch: epochs.authzEpoch,
            orgContentEpoch: epochs.orgContentEpoch,
            bucket: bucketOf(now.getTime(), CACHE_BUCKET_MS),
          };
          const permittedIds = cache.get(key);
          const r = await retrieve(client, {
            orgId: auth.orgId,
            userId: auth.userId,
            query: q,
            k: req.body.k,
            now,
            queryVector: embedded.ok ? embedded.vector : null,
            degraded: embedded.ok ? null : embedded.reason,
            embedderModel: embedder?.model ?? null,
            permittedIds,
            semaphore,
            ...(options.tuning ? { tuning: options.tuning } : {}),
            ...(options.variant ? { variant: options.variant } : {}),
            ...(options.hooks ? { hooks: options.hooks } : {}),
          });
          if (r.computedPermitted) toCache = { key, ids: r.computedPermitted };
          return r;
        },
        {
          isolation: 'REPEATABLE READ',
          // The pair of epoch reads around the request: only a stable pair may be cached.
          onEpochCheck: (check) => {
            if (check.stable && toCache) cache.put(toCache.key, toCache.ids);
          },
          ...(options.tenantHooks ? { testHooks: options.tenantHooks } : {}),
        },
      );
      return {
        items: result.items,
        retrievalMode: result.retrievalMode,
        degraded: result.degraded,
      };
    },
  );
}
