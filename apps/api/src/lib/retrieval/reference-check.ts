// SPDX-License-Identifier: AGPL-3.0-only
// Independent post-check (ADR-0002, M2a spec "Reference post-check cost"). The retrieval SQL embeds
// readerVisibleSql; this module re-decides every returned chunk with the separately written reference
// predicate from @our-stream/authz (`readerVisible`, a plain graph walk) over a SCOPED snapshot read in the
// same REPEATABLE READ transaction: the candidate content ids, the tuples whose object is one of them or one
// of their audience streams, the groups reachable from the asker transitively up to MAX_GROUP_DEPTH, plus
// kind, current-version status, the org flag and the kill switch for those ids. Loader failure and any
// disagreement fail closed: the request throws, `authz.leak_check_failed` is incremented and nothing is
// returned.
import {
  MAX_GROUP_DEPTH,
  readerVisible,
  type ContentRow,
  type Membership,
  type OrgSnapshot,
  type Tuple,
  type VersionStatus,
} from '@our-stream/authz';
import type { TenantClient } from '@our-stream/db';
import { incrementCounter, LEAK_CHECK_FAILED } from './metrics.js';

export class LeakCheckError extends Error {
  constructor(
    message: string,
    readonly kind: 'disagreement' | 'loader_failure',
  ) {
    super(message);
    this.name = 'LeakCheckError';
  }
}

export interface CheckedChunk {
  chunkId: string;
  contentId: string;
  versionId: string;
}

/** What the loader read, besides the snapshot: the content's current version pointer, for the chunk match. */
export interface ScopedSnapshot extends OrgSnapshot {
  currentVersionIds: Map<string, string | null>;
}

interface TupleRow {
  object_type: Tuple['objectType'];
  object_id: string;
  relation: string;
  subject_type: Tuple['subjectType'];
  subject_id: string;
  subject_relation: string;
}

const toTuple = (r: TupleRow): Tuple => ({
  objectType: r.object_type,
  objectId: r.object_id,
  relation: r.relation,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  subjectRelation: r.subject_relation,
});

export async function loadScopedSnapshot(
  client: TenantClient,
  orgId: string,
  userId: string,
  contentIds: readonly string[],
): Promise<ScopedSnapshot> {
  const ids = [...new Set(contentIds)];
  const members = await client.query<{
    user_id: string;
    role: Membership['role'];
    status: Membership['status'];
  }>('SELECT user_id, role, status FROM org_membership WHERE org_id = $1 AND user_id = $2', [
    orgId,
    userId,
  ]);
  const contentRows = await client.query<{
    id: string;
    kind: ContentRow['kind'];
    vstatus: VersionStatus | null;
    owner_id: string;
    state: ContentRow['state'];
    publish_at: Date | null;
    expires_at: Date | null;
    retracted_at: Date | null;
    review_requested: boolean;
    current_version_id: string | null;
  }>(
    `SELECT c.id, c.kind::text AS kind, v.status::text AS vstatus, c.owner_id, c.state::text AS state, c.publish_at,
            c.expires_at, c.retracted_at, c.review_requested, c.current_version_id
       FROM content c LEFT JOIN content_version v ON v.org_id = c.org_id AND v.id = c.current_version_id
      WHERE c.org_id = $1 AND c.id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  const flag = await client.query<{ enabled: boolean }>(
    `SELECT COALESCE(settings ->> 'documents_enabled', '') = 'true' AS enabled FROM org WHERE id = $1`,
    [orgId],
  );
  const kill = await client.query<{ engaged: boolean }>(
    'SELECT platform_documents_kill_switch_engaged() AS engaged',
  );
  const tupleSql = `SELECT object_type, object_id, relation, subject_type, subject_id, subject_relation FROM relation_tuple`;
  const audience = await client.query<TupleRow>(
    `${tupleSql} WHERE org_id = $1 AND object_type = 'content' AND object_id = ANY($2::uuid[])`,
    [orgId, ids],
  );
  const streamIds = [
    ...new Set(audience.rows.filter((t) => t.subject_type === 'stream').map((t) => t.subject_id)),
  ];
  const streamTuples =
    streamIds.length === 0
      ? { rows: [] as TupleRow[] }
      : await client.query<TupleRow>(
          `${tupleSql} WHERE org_id = $1 AND object_type = 'stream' AND object_id = ANY($2::uuid[])`,
          [orgId, streamIds],
        );
  // Group closure: the groups the asker belongs to, level by level, bounded by MAX_GROUP_DEPTH. A group
  // tuple is (object group, member, subject user|group).
  const groupTuples: TupleRow[] = [];
  const seenGroups = new Set<string>();
  let frontier: string[] = [userId];
  for (let depth = 0; depth < MAX_GROUP_DEPTH && frontier.length > 0; depth += 1) {
    const level = await client.query<TupleRow>(
      `${tupleSql} WHERE org_id = $1 AND object_type = 'group' AND relation = 'member'
         AND subject_type IN ('user', 'group') AND subject_id = ANY($2::uuid[])`,
      [orgId, frontier],
    );
    groupTuples.push(...level.rows);
    frontier = [];
    for (const t of level.rows) {
      if (!seenGroups.has(t.object_id)) {
        seenGroups.add(t.object_id);
        frontier.push(t.object_id);
      }
    }
  }
  const currentVersionIds = new Map<string, string | null>();
  const content: ContentRow[] = contentRows.rows.map((r) => {
    currentVersionIds.set(r.id, r.current_version_id);
    return {
      id: r.id,
      kind: r.kind,
      currentVersionStatus: r.vstatus,
      ownerId: r.owner_id,
      state: r.state,
      publishAt: r.publish_at,
      expiresAt: r.expires_at,
      retractedAt: r.retracted_at,
      reviewRequested: r.review_requested,
    };
  });
  return {
    orgId,
    memberships: members.rows.map((m) => ({ userId: m.user_id, role: m.role, status: m.status })),
    groups: [...seenGroups].map((id) => ({ id, isPrivate: false })),
    streams: streamIds,
    tuples: [...audience.rows, ...streamTuples.rows, ...groupTuples].map(toTuple),
    content,
    documentsEnabled: flag.rows[0]?.enabled === true,
    documentsKillSwitch: kill.rows[0]?.engaged === true,
    currentVersionIds,
  };
}

/**
 * Re-decides each chunk with the reference predicate at the request's captured `now`. A chunk passes only if
 * its version is the content's current version, that version is `current`, and `readerVisible` holds.
 * Throws LeakCheckError (counter incremented) on any failure; never returns a partial answer.
 */
export async function referencePostCheck(
  client: TenantClient,
  orgId: string,
  userId: string,
  now: Date,
  chunks: readonly CheckedChunk[],
  loader: typeof loadScopedSnapshot = loadScopedSnapshot,
): Promise<void> {
  if (chunks.length === 0) return;
  let snap: ScopedSnapshot;
  try {
    snap = await loader(
      client,
      orgId,
      userId,
      chunks.map((c) => c.contentId),
    );
  } catch (err) {
    incrementCounter(LEAK_CHECK_FAILED);
    throw new LeakCheckError(
      `reference snapshot loader failed: ${(err as Error).message}`,
      'loader_failure',
    );
  }
  for (const c of chunks) {
    const row = snap.content.find((x) => x.id === c.contentId);
    const ok =
      row !== undefined &&
      snap.currentVersionIds.get(c.contentId) === c.versionId &&
      row.currentVersionStatus === 'current' &&
      readerVisible(snap, userId, c.contentId, now);
    if (!ok) {
      incrementCounter(LEAK_CHECK_FAILED);
      throw new LeakCheckError(
        'reference predicate disagrees with the query result',
        'disagreement',
      );
    }
  }
}
