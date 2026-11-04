// SPDX-License-Identifier: AGPL-3.0-only
// Engagement events and per-clip stats (ADR-0006). Events are idempotent per playback session in the
// database (record_engagement); stats are author-only (authorAccessible) and carry viewer identities
// only under the org privacy mode `named`.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ContentStats,
  EngagementEventRequest,
  EngagementResponse,
  Uuid,
} from '@our-stream/contracts';
import { withTenant } from '@our-stream/db';
import type { AppContext } from '../context.js';
import { requireMember } from '../lib/auth.js';
import { requireAuthor } from '../lib/content.js';
import { conflict } from '../lib/errors.js';
import { requireBudget, visibleCurrentVersion } from '../lib/m1b-sql.js';
import { readOrgSettings, showsNamedViewers } from '../lib/settings.js';

const security = [{ cookieAuth: [] }, { bearerAuth: [] }];
const Params = z.object({ id: Uuid });
type Stats = z.infer<typeof ContentStats>;

export function registerEngagementRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/v1/content/:id/engagement',
    {
      schema: {
        tags: ['engagement'],
        params: Params,
        body: EngagementEventRequest,
        response: { 200: EngagementResponse },
        security,
      },
    },
    async (req) => {
      const auth = requireMember(req);
      requireBudget(ctx.limits.write, auth.sessionId);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        const current = await visibleCurrentVersion(client, req.params.id);
        if (current !== req.body.versionId)
          throw conflict('stale_version', 'that version is no longer current');
        const r = await client.query<{ recorded: boolean }>(
          'SELECT record_engagement($1, $2, $3, $4, $5) AS recorded',
          [
            req.params.id,
            req.body.versionId,
            req.body.type,
            req.body.sessionKey,
            req.body.positionMs ?? null,
          ],
        );
        return { recorded: r.rows[0]?.recorded === true };
      });
    },
  );

  app.get(
    '/v1/content/:id/stats',
    { schema: { tags: ['engagement'], params: Params, response: { 200: ContentStats }, security } },
    async (req) => {
      const auth = requireMember(req);
      return withTenant(ctx.pool, { orgId: auth.orgId, userId: auth.userId }, async (client) => {
        await requireAuthor(client, req.params.id); // 404 for everyone else, as the editing routes
        const settings = await readOrgSettings(client);
        const agg = await client.query<{
          unique_viewers: number;
          view_starts: number;
          completions: number;
          rewatches: number;
          p25: number;
          p50: number;
          p75: number;
          likes: number;
          comments: number;
        }>(
          `SELECT count(DISTINCT e.user_id) FILTER (WHERE e.type = 'view_start')::int AS unique_viewers,
                  count(*) FILTER (WHERE e.type = 'view_start')::int AS view_starts,
                  count(*) FILTER (WHERE e.type = 'complete')::int AS completions,
                  count(*) FILTER (WHERE e.type = 'rewatch')::int AS rewatches,
                  count(*) FILTER (WHERE e.type = 'progress_25')::int AS p25,
                  count(*) FILTER (WHERE e.type = 'progress_50')::int AS p50,
                  count(*) FILTER (WHERE e.type = 'progress_75')::int AS p75,
                  (SELECT count(*)::int FROM reaction r WHERE r.org_id = $1 AND r.content_id = $2) AS likes,
                  (SELECT count(*)::int FROM comment k WHERE k.org_id = $1 AND k.content_id = $2 AND k.state = 'visible') AS comments
           FROM engagement_event e WHERE e.org_id = $1 AND e.content_id = $2`,
          [auth.orgId, req.params.id],
        );
        const a = agg.rows[0]!;
        const stats: Stats = {
          contentId: req.params.id,
          privacyMode: settings.privacyMode,
          uniqueViewers: a.unique_viewers,
          viewStarts: a.view_starts,
          completions: a.completions,
          rewatches: a.rewatches,
          milestones: { p25: a.p25, p50: a.p50, p75: a.p75 },
          likes: a.likes,
          comments: a.comments,
        };
        if (showsNamedViewers(settings)) {
          const viewers = await client.query<{
            user_id: string;
            display_name: string | null;
            first_viewed_at: Date | null;
            last_viewed_at: Date | null;
            max_progress_pct: number;
            completed: boolean;
            watch_count: number;
          }>(
            `SELECT s.user_id, a.display_name, s.first_viewed_at, s.last_viewed_at, s.max_progress_pct,
                    s.completed_at IS NOT NULL AS completed, s.watch_count
             FROM user_content_state s LEFT JOIN LATERAL platform_account_get(s.user_id) a ON true
             WHERE s.org_id = $1 AND s.content_id = $2 AND s.first_viewed_at IS NOT NULL
             ORDER BY s.last_viewed_at DESC NULLS LAST, s.user_id LIMIT 500`,
            [auth.orgId, req.params.id],
          );
          stats.viewers = viewers.rows.map((v) => ({
            userId: v.user_id,
            displayName: v.display_name ?? 'unknown',
            firstViewedAt: v.first_viewed_at?.toISOString() ?? null,
            lastViewedAt: v.last_viewed_at?.toISOString() ?? null,
            maxProgressPct: v.max_progress_pct,
            completed: v.completed,
            watchCount: v.watch_count,
          }));
        }
        return stats;
      });
    },
  );
}
