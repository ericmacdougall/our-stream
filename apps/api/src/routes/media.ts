// SPDX-License-Identifier: AGPL-3.0-only
// Authenticated media proxy (ADR-0003). Every request (playlist, caption, segment) is re-authorised:
// active member, content readerVisible, requested version is the current one, and when a media token is
// used its signature must match the content's current media key (rotated on retraction). Objects are
// streamed from storage with Range support; playlists are rewritten so URIs stay under this route.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { readerVisibleSql } from '@our-stream/authz';
import { Uuid } from '@our-stream/contracts';
import { withTenant } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import {
  cacheControlFor,
  classify,
  contentTypeFor,
  rewritePlaylist,
  safeRelativePath,
} from '../lib/media.js';
import { RangeNotSatisfiable, derivedPrefix } from '../lib/storage.js';
import { mediaTokenValid, parseMediaToken } from '../lib/tokens.js';

const Params = z.object({ contentId: Uuid, versionId: Uuid, '*': z.string().min(1).max(512) });
const Query = z.object({ t: z.string().max(300).optional() });

interface Gate {
  retracted_at: Date | null;
  current_version_id: string | null;
  media_key_id: string;
  v_status: string | null;
  visible: boolean;
}

export function registerMediaRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/media/:contentId/:versionId/*',
    {
      schema: {
        tags: ['media'],
        params: Params,
        querystring: Query,
        hide: true,
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { contentId, versionId } = req.params;
      const rel = req.params['*'];
      if (!safeRelativePath(rel)) throw notFound('media_not_found', 'not found');

      // Identity: the session when present, otherwise the media token (native players).
      let userId: string;
      let orgId: string;
      let token: ReturnType<typeof parseMediaToken> = null;
      if (req.auth) {
        if (!req.auth.orgId || req.auth.membership?.status !== 'active')
          throw forbidden('not_member', 'membership is not active');
        userId = req.auth.userId;
        orgId = req.auth.orgId;
      } else if (req.query.t) {
        token = parseMediaToken(req.query.t);
        if (!token) throw forbidden('bad_token', 'invalid media token');
        userId = token.userId;
        orgId = token.orgId;
      } else {
        throw unauthorized();
      }

      await withTenant(ctx.pool, { orgId, userId }, async (client) => {
        const r = await client.query<Gate>(
          `SELECT c.retracted_at, c.current_version_id, c.media_key_id, v.status AS v_status,
                  ${readerVisibleSql({ org: '$1', user: '$2' })} AS visible
           FROM content c
           LEFT JOIN content_version v ON v.org_id = c.org_id AND v.content_id = c.id AND v.id = $4
           WHERE c.org_id = $1 AND c.id = $3`,
          [orgId, userId, contentId, versionId],
        );
        const g = r.rows[0];
        if (!g || g.retracted_at !== null) throw notFound('media_not_found', 'not found');
        if (g.current_version_id !== versionId || g.v_status !== 'current')
          throw notFound('media_not_found', 'not found');
        if (
          token &&
          !mediaTokenValid(ctx.config.MEDIA_HMAC_SECRET, token, versionId, g.media_key_id)
        )
          throw forbidden('bad_token', 'invalid media token');
        if (!g.visible) throw forbidden('forbidden', 'you cannot view this item');
      });

      const key = `${derivedPrefix(orgId, contentId, versionId)}${rel}`;
      const cls = classify(rel);
      reply.header('cache-control', cacheControlFor(cls));
      reply.header('content-type', contentTypeFor(rel, null));

      if (cls === 'playlist') {
        const obj = await ctx.store.get(key);
        if (!obj) throw notFound('media_not_found', 'not found');
        const text = await readAll(obj.body);
        const rewritten = rewritePlaylist(text, contentId, versionId, req.query.t ?? null);
        if (rewritten.dropped > 0)
          req.log.warn(
            { contentId, versionId, dropped: rewritten.dropped },
            'playlist URIs dropped',
          );
        return reply.send(rewritten.text);
      }

      const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      let obj;
      try {
        obj = await ctx.store.get(key, range);
      } catch (err) {
        if (err instanceof RangeNotSatisfiable) return reply.status(416).send();
        throw err;
      }
      if (!obj) throw notFound('media_not_found', 'not found');
      reply.header('accept-ranges', 'bytes');
      reply.header('content-type', contentTypeFor(rel, obj.contentType));
      if (obj.contentLength !== null) reply.header('content-length', String(obj.contentLength));
      if (obj.contentRange) reply.header('content-range', obj.contentRange);
      return reply.status(obj.status).send(obj.body);
    },
  );
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
