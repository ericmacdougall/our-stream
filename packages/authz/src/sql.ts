// SPDX-License-Identifier: AGPL-3.0-only
// Single generated SQL predicate for reader paths (ADR-0002). Every list, feed, search, retrieval,
// media and notification query must embed readerVisibleSql(); nothing else may decide visibility.
// Parameters are positional: $org and $user are replaced with the given placeholders.

export interface PredicateParams {
  /** SQL placeholder for the org id, e.g. '$1'. */
  org: string;
  /** SQL placeholder for the user id, e.g. '$2'. */
  user: string;
  /** Alias of the content table in the outer query. Default 'c'. */
  contentAlias?: string;
  /** SQL expression for "now". Default now(). Tests pass a fixed timestamp. */
  now?: string;
}

export function readerVisibleSql(p: PredicateParams): string {
  const c = p.contentAlias ?? 'c';
  const now = p.now ?? 'now()';
  return `(
    EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = ${p.org} AND m.user_id = ${p.user} AND m.status = 'active')
    AND ${c}.org_id = ${p.org}
    AND ${c}.state = 'published'
    AND ${c}.publish_at IS NOT NULL AND ${c}.publish_at <= ${now}
    AND (${c}.expires_at IS NULL OR ${c}.expires_at > ${now})
    AND ${c}.retracted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM content_audience a
      WHERE a.org_id = ${c}.org_id AND a.content_id = ${c}.id AND (
           a.kind = 'org'
        OR (a.kind = 'user'   AND a.principal_id = ${p.user})
        OR (a.kind = 'group'  AND a.principal_id IN (SELECT ugm.group_id  FROM user_group_membership ugm WHERE ugm.org_id = ${p.org} AND ugm.user_id = ${p.user}))
        OR (a.kind = 'stream' AND a.principal_id IN (SELECT usa.stream_id FROM user_stream_access usa WHERE usa.org_id = ${p.org} AND usa.user_id = ${p.user}))
      )
    )
  )`;
}

/** authorAccessible for editing/moderation endpoints (ADR-0002 v2 rules). */
export function authorAccessibleSql(p: PredicateParams): string {
  const c = p.contentAlias ?? 'c';
  return `(
    EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = ${p.org} AND m.user_id = ${p.user} AND m.status = 'active')
    AND ${c}.org_id = ${p.org}
    AND (
         ${c}.owner_id = ${p.user}
      OR EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = ${p.org} AND m.user_id = ${p.user} AND m.role IN ('owner','admin'))
      OR EXISTS (SELECT 1 FROM relation_tuple t WHERE t.org_id = ${p.org} AND t.object_type = 'content' AND t.object_id = ${c}.id
                 AND t.relation = 'editor' AND t.subject_type = 'user' AND t.subject_id = ${p.user})
      OR (
        (${c}.state <> 'draft' OR ${c}.review_requested)
        AND EXISTS (
          SELECT 1 FROM content_audience a JOIN user_stream_access usa
            ON usa.org_id = a.org_id AND usa.stream_id = a.principal_id AND usa.user_id = ${p.user}
          WHERE a.org_id = ${c}.org_id AND a.content_id = ${c}.id AND a.kind = 'stream' AND usa.role IN ('moderator','owner'))
      )
    )
  )`;
}

export function auditorAccessibleSql(p: PredicateParams): string {
  return `EXISTS (SELECT 1 FROM org_membership m WHERE m.org_id = ${p.org} AND m.user_id = ${p.user} AND m.status = 'active' AND m.role IN ('owner','admin','auditor'))`;
}
