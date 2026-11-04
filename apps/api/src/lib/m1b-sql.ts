// SPDX-License-Identifier: AGPL-3.0-only
// SQL fragments shared by the M1b reader paths (feed, detail, search, comments). Everything that
// reveals existence still goes through readerVisibleSql; these fragments only decorate rows the caller
// already filtered, or narrow them further (pins and tags never widen visibility, ADR-0002 side channels).
import { readerVisibleSql } from '@our-stream/authz';
import type { TenantClient } from '@our-stream/db';
import { ApiError, notFound } from './errors.js';
import type { FixedWindowLimiter } from './limits.js';

/** Likes on the item (count) and whether `$user` liked it. */
export const likeCountSql = (c: string) =>
  `(SELECT count(*)::int FROM reaction r WHERE r.org_id = ${c}.org_id AND r.content_id = ${c}.id)`;
export const likedSql = (c: string, user: string) =>
  `EXISTS (SELECT 1 FROM reaction r WHERE r.org_id = ${c}.org_id AND r.content_id = ${c}.id AND r.user_id = ${user})`;
/** Visible comments only: tombstones never inflate counters (review F18). */
export const commentCountSql = (c: string) =>
  `(SELECT count(*)::int FROM comment k WHERE k.org_id = ${c}.org_id AND k.content_id = ${c}.id AND k.state = 'visible')`;

/**
 * Pinned for this viewer: org-wide pins, or a pin in a stream the item is still addressed to and the
 * viewer can access (review F19). Never changes which items are visible, only decorates/narrows them.
 */
export const pinnedSql = (c: string, user: string) => `EXISTS (
  SELECT 1 FROM content_pin p WHERE p.org_id = ${c}.org_id AND p.content_id = ${c}.id AND (
       p.scope_kind = 'org'
    OR (p.scope_kind = 'stream'
        AND EXISTS (SELECT 1 FROM content_audience au WHERE au.org_id = ${c}.org_id AND au.content_id = ${c}.id AND au.kind = 'stream' AND au.principal_id = p.scope_id)
        AND EXISTS (SELECT 1 FROM user_stream_access usa WHERE usa.org_id = ${c}.org_id AND usa.user_id = ${user} AND usa.stream_id = p.scope_id))))`;

/** Comments allowed on the item: org switch on and no audience stream switched off (decision Q7). */
export const commentsEnabledSql = (c: string) => `(
  COALESCE((SELECT (o.settings -> 'comments' ->> 'enabled') IS DISTINCT FROM 'false' FROM org o WHERE o.id = ${c}.org_id), true)
  AND NOT EXISTS (
    SELECT 1 FROM content_audience au JOIN stream s ON s.org_id = au.org_id AND s.id = au.principal_id
    WHERE au.org_id = ${c}.org_id AND au.content_id = ${c}.id AND au.kind = 'stream' AND (s.settings -> 'comments' ->> 'enabled') = 'false'))`;

/** Stream filter used by feed and search: the viewer can access the stream and the item is addressed to it. */
export const streamFilterSql = (c: string, org: string, user: string, stream: string) => `(
  ${stream}::uuid IS NULL OR (
    EXISTS (SELECT 1 FROM user_stream_access usa WHERE usa.org_id = ${org} AND usa.user_id = ${user} AND usa.stream_id = ${stream})
    AND EXISTS (SELECT 1 FROM content_audience au WHERE au.org_id = ${c}.org_id AND au.content_id = ${c}.id AND au.kind = 'stream' AND au.principal_id = ${stream})))`;

export const tagFilterSql = (c: string, tag: string) =>
  `(${tag}::text IS NULL OR ${tag}::text = ANY(${c}.event_tags))`;

/** The streams of the item the viewer can access, as the feed reports them. */
export const viewerStreamsSql = (c: string, user: string) =>
  `COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'kind', s.kind) ORDER BY s.name)
             FROM content_audience au
             JOIN stream s ON s.org_id = au.org_id AND s.id = au.principal_id
             JOIN user_stream_access usa ON usa.org_id = au.org_id AND usa.stream_id = au.principal_id AND usa.user_id = ${user}
             WHERE au.org_id = ${c}.org_id AND au.content_id = ${c}.id AND au.kind = 'stream'), '[]'::json)`;

/** 404 unless the item is reader-visible to the tenant user: invisible and missing are indistinguishable. */
export async function requireVisible(client: TenantClient, contentId: string): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM content c WHERE c.org_id = $1 AND c.id = $3 AND ${readerVisibleSql({ org: '$1', user: '$2' })}`,
    [client.tenant.orgId, client.tenant.userId, contentId],
  );
  if ((r.rowCount ?? 0) === 0) throw notFound('content_not_found', 'content not found');
}

/** The reader-visible item's current version id (404 otherwise, as the M1a view route). */
export async function visibleCurrentVersion(
  client: TenantClient,
  contentId: string,
): Promise<string> {
  const r = await client.query<{ current_version_id: string | null; v_status: string | null }>(
    `SELECT c.current_version_id, v.status AS v_status FROM content c
     LEFT JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id
     WHERE c.org_id = $1 AND c.id = $3 AND ${readerVisibleSql({ org: '$1', user: '$2' })}`,
    [client.tenant.orgId, client.tenant.userId, contentId],
  );
  const row = r.rows[0];
  if (!row || !row.current_version_id || row.v_status !== 'current')
    throw notFound('content_not_found', 'content not found');
  return row.current_version_id;
}

export function requireBudget(limiter: FixedWindowLimiter, key: string): void {
  if (!limiter.allow(key)) throw new ApiError(429, 'rate_limited', 'too many requests');
}

export async function audit(
  client: TenantClient,
  action: string,
  target: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_event (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4::jsonb)`,
    [client.tenant.orgId, client.tenant.userId, action, JSON.stringify(target)],
  );
}
