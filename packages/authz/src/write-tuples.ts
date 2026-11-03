// SPDX-License-Identifier: AGPL-3.0-only
// The only writer of relation tuples (ADR-0002 "Writing tuples"). Validates publish/grant rules and
// group depth/cycle constraints before touching the database. Sharing never calls this.
import type { TenantClient } from '@our-stream/db';
import { MAX_GROUP_DEPTH, type Tuple } from './model.js';

export class AuthzRuleError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

async function actorRole(client: TenantClient): Promise<{ role: string; active: boolean } | null> {
  const { orgId, userId } = client.tenant;
  if (!userId) return null;
  const r = await client.query<{ role: string; status: string }>(
    'SELECT role, status FROM org_membership WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  const row = r.rows[0];
  return row ? { role: row.role, active: row.status === 'active' } : null;
}

async function actorStreamRole(client: TenantClient, streamId: string): Promise<string | null> {
  const { orgId, userId } = client.tenant;
  const r = await client.query<{ role: string }>(
    'SELECT role FROM user_stream_access WHERE org_id = $1 AND user_id = $2 AND stream_id = $3',
    [orgId, userId, streamId],
  );
  return r.rows[0]?.role ?? null;
}

async function actorInGroup(client: TenantClient, groupId: string): Promise<boolean> {
  const { orgId, userId } = client.tenant;
  const r = await client.query(
    'SELECT 1 FROM user_group_membership WHERE org_id = $1 AND user_id = $2 AND group_id = $3',
    [orgId, userId, groupId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Depth of the group graph if `child` becomes a member of `parent`; throws on cycle. */
async function groupNestingOk(client: TenantClient, parent: string, child: string): Promise<void> {
  const { orgId } = client.tenant;
  if (parent === child) throw new AuthzRuleError('a group cannot contain itself', 'group_cycle');
  // ancestors of parent (groups that contain parent, transitively)
  const anc = await client.query<{ id: string; depth: number }>(
    `WITH RECURSIVE up(id, depth) AS (
       SELECT $2::uuid, 0
       UNION
       SELECT t.object_id, up.depth + 1 FROM relation_tuple t JOIN up ON t.org_id = $1 AND t.object_type = 'group'
         AND t.relation = 'member' AND t.subject_type = 'group' AND t.subject_id = up.id AND up.depth < 16)
     SELECT id, depth FROM up`,
    [orgId, parent],
  );
  if (anc.rows.some((r) => r.id === child))
    throw new AuthzRuleError('group membership would create a cycle', 'group_cycle');
  const down = await client.query<{ depth: number }>(
    `WITH RECURSIVE down(id, depth) AS (
       SELECT $2::uuid, 0
       UNION
       SELECT t.subject_id, down.depth + 1 FROM relation_tuple t JOIN down ON t.org_id = $1 AND t.object_type = 'group'
         AND t.relation = 'member' AND t.subject_type = 'group' AND t.object_id = down.id AND down.depth < 16)
     SELECT max(depth) AS depth FROM down`,
    [orgId, child],
  );
  const up = Math.max(0, ...anc.rows.map((r) => r.depth));
  const below = down.rows[0]?.depth ?? 0;
  if (up + 1 + below > MAX_GROUP_DEPTH)
    throw new AuthzRuleError(`group nesting deeper than ${MAX_GROUP_DEPTH}`, 'group_depth');
}

/**
 * Validates and writes one tuple inside the caller's tenant transaction. Triggers maintain the
 * derived tables and epochs synchronously.
 */
export async function writeTuple(client: TenantClient, t: Tuple): Promise<void> {
  const { orgId, userId } = client.tenant;
  const actor = await actorRole(client);
  if (!actor || !actor.active)
    throw new AuthzRuleError('actor is not an active member', 'not_member');
  const isAdmin = actor.role === 'owner' || actor.role === 'admin';

  if (t.objectType === 'content' && t.relation === 'viewer') {
    const owns = await client.query(
      'SELECT 1 FROM content WHERE org_id = $1 AND id = $2 AND (owner_id = $3 OR $4)',
      [orgId, t.objectId, userId, isAdmin],
    );
    const editor = await client.query(
      `SELECT 1 FROM relation_tuple WHERE org_id = $1 AND object_type = 'content' AND object_id = $2 AND relation = 'editor' AND subject_type = 'user' AND subject_id = $3`,
      [orgId, t.objectId, userId],
    );
    if ((owns.rowCount ?? 0) === 0 && (editor.rowCount ?? 0) === 0)
      throw new AuthzRuleError(
        'only the owner, editors or admins may set the audience',
        'not_author',
      );
    if (t.subjectType === 'org') {
      if (!(isAdmin || actor.role === 'announcer'))
        throw new AuthzRuleError(
          'org-wide publishing requires announcer or admin',
          'org_wide_forbidden',
        );
      if (t.subjectRelation !== 'member')
        throw new AuthzRuleError('org audience must be org#member', 'bad_subject');
    } else if (t.subjectType === 'stream') {
      const role = await actorStreamRole(client, t.subjectId);
      if (!isAdmin && (role === null || role === 'viewer'))
        throw new AuthzRuleError(
          'publishing to a stream requires contributor or higher on it',
          'stream_forbidden',
        );
      if (t.subjectRelation !== 'viewer')
        throw new AuthzRuleError('stream audience must be stream#viewer', 'bad_subject');
    } else if (t.subjectType === 'group') {
      if (!isAdmin && !(await actorInGroup(client, t.subjectId)))
        throw new AuthzRuleError(
          'publishing to a group requires membership of it',
          'group_forbidden',
        );
    } else if (t.subjectType === 'user') {
      const target = await client.query(
        'SELECT 1 FROM org_membership WHERE org_id = $1 AND user_id = $2 AND status = $3',
        [orgId, t.subjectId, 'active'],
      );
      if ((target.rowCount ?? 0) === 0)
        throw new AuthzRuleError('target user is not an active member', 'target_inactive');
    }
  } else if (t.objectType === 'content' && t.relation === 'editor') {
    const owns = await client.query(
      'SELECT 1 FROM content WHERE org_id = $1 AND id = $2 AND (owner_id = $3 OR $4)',
      [orgId, t.objectId, userId, isAdmin],
    );
    if ((owns.rowCount ?? 0) === 0)
      throw new AuthzRuleError('only the owner or admins may add editors', 'not_owner');
  } else if (t.objectType === 'group') {
    if (t.relation !== 'member')
      throw new AuthzRuleError('groups only have the member relation', 'bad_relation');
    if (!isAdmin)
      throw new AuthzRuleError('group membership changes require admin', 'admin_required');
    if (t.subjectType === 'group') await groupNestingOk(client, t.objectId, t.subjectId);
  } else if (t.objectType === 'stream') {
    const role = await actorStreamRole(client, t.objectId);
    if (!isAdmin && role !== 'owner')
      throw new AuthzRuleError(
        'stream role grants require stream owner or admin',
        'stream_owner_required',
      );
    if (!['viewer', 'contributor', 'moderator', 'owner'].includes(t.relation))
      throw new AuthzRuleError('unknown stream relation', 'bad_relation');
  } else if (t.objectType === 'org') {
    throw new AuthzRuleError(
      'org roles are managed through org_membership, not tuples',
      'bad_object',
    );
  } else {
    throw new AuthzRuleError('unsupported tuple', 'bad_object');
  }

  await client.query(
    `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
    [
      orgId,
      t.objectType,
      t.objectId,
      t.relation,
      t.subjectType,
      t.subjectId,
      t.subjectRelation,
      userId,
    ],
  );
}

/** Removes a tuple; the same authority rules as writing apply (revocation is synchronous via triggers). */
export async function deleteTuple(client: TenantClient, t: Tuple): Promise<void> {
  const { orgId, userId } = client.tenant;
  const actor = await actorRole(client);
  if (!actor || !actor.active)
    throw new AuthzRuleError('actor is not an active member', 'not_member');
  const isAdmin = actor.role === 'owner' || actor.role === 'admin';
  if (t.objectType === 'content') {
    const owns = await client.query(
      'SELECT 1 FROM content WHERE org_id = $1 AND id = $2 AND (owner_id = $3 OR $4)',
      [orgId, t.objectId, userId, isAdmin],
    );
    if ((owns.rowCount ?? 0) === 0)
      throw new AuthzRuleError('only the owner or admins may change the audience', 'not_author');
  } else if (t.objectType === 'group' && !isAdmin) {
    throw new AuthzRuleError('group membership changes require admin', 'admin_required');
  } else if (t.objectType === 'stream') {
    const role = await actorStreamRole(client, t.objectId);
    if (!isAdmin && role !== 'owner')
      throw new AuthzRuleError(
        'stream role changes require stream owner or admin',
        'stream_owner_required',
      );
  }
  await client.query(
    `DELETE FROM relation_tuple WHERE org_id = $1 AND object_type = $2 AND object_id = $3 AND relation = $4 AND subject_type = $5 AND subject_id = $6 AND subject_relation = $7`,
    [orgId, t.objectType, t.objectId, t.relation, t.subjectType, t.subjectId, t.subjectRelation],
  );
}
