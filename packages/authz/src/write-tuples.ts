// SPDX-License-Identifier: AGPL-3.0-only
// The only writer of relation tuples (ADR-0002 "Writing tuples"). Validates publish and grant rules and
// group depth/cycle constraints inside the caller's tenant transaction, then inserts. Sharing never
// calls this. Triggers maintain derived tables and epochs synchronously; an org-level advisory lock in
// the trigger serialises concurrent tuple changes.
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

const STREAM_RELATIONS = new Set(['viewer', 'contributor', 'moderator', 'owner']);

interface Actor {
  role: string;
  isAdmin: boolean;
}

async function requireActiveActor(client: TenantClient): Promise<Actor> {
  const { orgId, userId } = client.tenant;
  if (!userId) throw new AuthzRuleError('actor required', 'not_member');
  const r = await client.query<{ role: string; status: string }>(
    'SELECT role, status FROM org_membership WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  const row = r.rows[0];
  if (!row || row.status !== 'active')
    throw new AuthzRuleError('actor is not an active member', 'not_member');
  return { role: row.role, isAdmin: row.role === 'owner' || row.role === 'admin' };
}

async function actorStreamRole(client: TenantClient, streamId: string): Promise<string | null> {
  const { orgId, userId } = client.tenant;
  const r = await client.query<{ role: string }>(
    'SELECT role FROM user_stream_access WHERE org_id = $1 AND user_id = $2 AND stream_id = $3',
    [orgId, userId, streamId],
  );
  return r.rows[0]?.role ?? null;
}

async function lockOrg(client: TenantClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('authz:' || $1::text))`, [
    client.tenant.orgId,
  ]);
}

async function exists(client: TenantClient, sql: string, params: unknown[]): Promise<boolean> {
  const r = await client.query(sql, params);
  return (r.rowCount ?? 0) > 0;
}

async function requireStream(client: TenantClient, streamId: string): Promise<{ kind: string }> {
  const r = await client.query<{ kind: string }>(
    'SELECT kind FROM stream WHERE org_id = $1 AND id = $2',
    [client.tenant.orgId, streamId],
  );
  const row = r.rows[0];
  if (!row) throw new AuthzRuleError('stream does not exist', 'no_such_stream');
  return row;
}

async function requireGroup(client: TenantClient, groupId: string): Promise<void> {
  if (
    !(await exists(client, 'SELECT 1 FROM "group" WHERE org_id = $1 AND id = $2', [
      client.tenant.orgId,
      groupId,
    ]))
  ) {
    throw new AuthzRuleError('group does not exist', 'no_such_group');
  }
}

/** True when the actor owns the content, is an editor of it, or is an org admin/owner. */
async function canEditContent(
  client: TenantClient,
  contentId: string,
  actor: Actor,
): Promise<boolean> {
  const { orgId, userId } = client.tenant;
  if (actor.isAdmin) return true;
  if (
    await exists(client, 'SELECT 1 FROM content WHERE org_id = $1 AND id = $2 AND owner_id = $3', [
      orgId,
      contentId,
      userId,
    ])
  )
    return true;
  return exists(
    client,
    `SELECT 1 FROM relation_tuple WHERE org_id = $1 AND object_type = 'content' AND object_id = $2 AND relation = 'editor' AND subject_type = 'user' AND subject_id = $3`,
    [orgId, contentId, userId],
  );
}

/** Depth and cycle check for making `child` a member of `parent`. */
async function groupNestingOk(client: TenantClient, parent: string, child: string): Promise<void> {
  const { orgId } = client.tenant;
  if (parent === child) throw new AuthzRuleError('a group cannot contain itself', 'group_cycle');
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
  const down = await client.query<{ depth: number | null }>(
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
  // The closure walks MAX_GROUP_DEPTH hops including the user->group edge, so at most MAX_GROUP_DEPTH - 1 group->group edges.
  if (up + 1 + below > MAX_GROUP_DEPTH - 1)
    throw new AuthzRuleError(
      `group nesting deeper than ${MAX_GROUP_DEPTH - 1} levels`,
      'group_depth',
    );
}

/**
 * ADR-0002: content already addressed to a private stream may only be re-targeted outside that stream by
 * a moderator/owner of the private stream or an org admin.
 */
async function privateStreamGuard(
  client: TenantClient,
  contentId: string,
  t: Tuple,
  actor: Actor,
): Promise<void> {
  if (actor.isAdmin) return;
  const { orgId } = client.tenant;
  const r = await client.query<{ stream_id: string }>(
    `SELECT a.principal_id AS stream_id FROM content_audience a JOIN stream s ON s.org_id = a.org_id AND s.id = a.principal_id
     WHERE a.org_id = $1 AND a.content_id = $2 AND a.kind = 'stream' AND s.kind = 'private'`,
    [orgId, contentId],
  );
  for (const row of r.rows) {
    const targetsSameStream = t.subjectType === 'stream' && t.subjectId === row.stream_id;
    if (targetsSameStream) continue;
    const role = await actorStreamRole(client, row.stream_id);
    if (role !== 'moderator' && role !== 'owner') {
      throw new AuthzRuleError(
        'content in a private stream can only be re-targeted by its moderators',
        'private_stream_retarget',
      );
    }
  }
}

async function validateContentAudience(
  client: TenantClient,
  t: Tuple,
  actor: Actor,
): Promise<void> {
  const { orgId } = client.tenant;
  if (!(await canEditContent(client, t.objectId, actor)))
    throw new AuthzRuleError(
      'only the owner, editors or admins may set the audience',
      'not_author',
    );
  await privateStreamGuard(client, t.objectId, t, actor);
  switch (t.subjectType) {
    case 'org':
      if (t.subjectId !== orgId || t.subjectRelation !== 'member')
        throw new AuthzRuleError('org audience must be this org#member', 'bad_subject');
      if (!(actor.isAdmin || actor.role === 'announcer'))
        throw new AuthzRuleError(
          'org-wide publishing requires announcer or admin',
          'org_wide_forbidden',
        );
      return;
    case 'stream': {
      if (t.subjectRelation !== 'viewer')
        throw new AuthzRuleError('stream audience must be stream#viewer', 'bad_subject');
      await requireStream(client, t.subjectId);
      const role = await actorStreamRole(client, t.subjectId);
      if (!actor.isAdmin && (role === null || role === 'viewer'))
        throw new AuthzRuleError(
          'publishing to a stream requires contributor or higher on it',
          'stream_forbidden',
        );
      return;
    }
    case 'group': {
      if (t.subjectRelation !== '')
        throw new AuthzRuleError('group audience takes no subject relation', 'bad_subject');
      await requireGroup(client, t.subjectId);
      const inGroup = await exists(
        client,
        'SELECT 1 FROM user_group_membership WHERE org_id = $1 AND user_id = $2 AND group_id = $3',
        [orgId, client.tenant.userId, t.subjectId],
      );
      if (!actor.isAdmin && !inGroup)
        throw new AuthzRuleError(
          'publishing to a group requires membership of it',
          'group_forbidden',
        );
      return;
    }
    case 'user': {
      if (t.subjectRelation !== '')
        throw new AuthzRuleError('user audience takes no subject relation', 'bad_subject');
      const active = await exists(
        client,
        `SELECT 1 FROM org_membership WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
        [orgId, t.subjectId],
      );
      if (!active)
        throw new AuthzRuleError('target user is not an active member', 'target_inactive');
      return;
    }
  }
}

async function validate(client: TenantClient, t: Tuple, actor: Actor): Promise<void> {
  switch (t.objectType) {
    case 'content':
      if (t.relation === 'viewer') return validateContentAudience(client, t, actor);
      if (t.relation === 'editor') {
        if (t.subjectType !== 'user' || t.subjectRelation !== '')
          throw new AuthzRuleError('editors are users', 'bad_subject');
        const owner = await exists(
          client,
          'SELECT 1 FROM content WHERE org_id = $1 AND id = $2 AND owner_id = $3',
          [client.tenant.orgId, t.objectId, client.tenant.userId],
        );
        if (!actor.isAdmin && !owner)
          throw new AuthzRuleError('only the owner or admins may manage editors', 'not_owner');
        const active = await exists(
          client,
          `SELECT 1 FROM org_membership WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
          [client.tenant.orgId, t.subjectId],
        );
        if (!active)
          throw new AuthzRuleError('target user is not an active member', 'target_inactive');
        return;
      }
      throw new AuthzRuleError('unknown content relation', 'bad_relation');
    case 'group':
      if (t.relation !== 'member')
        throw new AuthzRuleError('groups only have the member relation', 'bad_relation');
      if (!actor.isAdmin)
        throw new AuthzRuleError('group membership changes require admin', 'admin_required');
      if (t.subjectRelation !== '')
        throw new AuthzRuleError('group members take no subject relation', 'bad_subject');
      await requireGroup(client, t.objectId);
      if (t.subjectType === 'group') {
        await requireGroup(client, t.subjectId);
        await groupNestingOk(client, t.objectId, t.subjectId);
      } else if (t.subjectType !== 'user') {
        throw new AuthzRuleError('group members are users or groups', 'bad_subject');
      }
      return;
    case 'stream': {
      if (!STREAM_RELATIONS.has(t.relation))
        throw new AuthzRuleError('unknown stream relation', 'bad_relation');
      await requireStream(client, t.objectId);
      const role = await actorStreamRole(client, t.objectId);
      if (!actor.isAdmin && role !== 'owner')
        throw new AuthzRuleError(
          'stream role grants require stream owner or admin',
          'stream_owner_required',
        );
      if (t.subjectType === 'org') {
        if (
          t.subjectId !== client.tenant.orgId ||
          t.subjectRelation !== 'member' ||
          t.relation !== 'viewer'
        ) {
          throw new AuthzRuleError(
            'everyone can only be granted viewer on a stream',
            'bad_subject',
          );
        }
      } else if (t.subjectType === 'group') {
        if (t.subjectRelation !== '')
          throw new AuthzRuleError('group subjects take no relation', 'bad_subject');
        await requireGroup(client, t.subjectId);
      } else if (t.subjectType === 'user') {
        if (t.subjectRelation !== '')
          throw new AuthzRuleError('user subjects take no relation', 'bad_subject');
      } else {
        throw new AuthzRuleError(
          'stream roles are granted to users, groups or everyone',
          'bad_subject',
        );
      }
      return;
    }
    case 'org':
      throw new AuthzRuleError(
        'org roles are managed through org_membership, not tuples',
        'bad_object',
      );
    default:
      throw new AuthzRuleError('unsupported tuple', 'bad_object');
  }
}

/** Validates and writes one tuple inside the caller's tenant transaction. */
export async function writeTuple(client: TenantClient, t: Tuple): Promise<void> {
  const actor = await requireActiveActor(client);
  await lockOrg(client); // serialises check-then-write against concurrent tuple changes (TOCTOU)
  await validate(client, t, actor);
  const { orgId, userId } = client.tenant;
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

/** Removes a tuple; revocation is applied synchronously by the trigger. Authority mirrors writeTuple. */
export async function deleteTuple(client: TenantClient, t: Tuple): Promise<void> {
  const actor = await requireActiveActor(client);
  await lockOrg(client);
  const { orgId } = client.tenant;
  switch (t.objectType) {
    case 'content': {
      if (t.relation !== 'viewer' && t.relation !== 'editor')
        throw new AuthzRuleError('unknown content relation', 'bad_relation');
      if (t.relation === 'editor') {
        const owner = await exists(
          client,
          'SELECT 1 FROM content WHERE org_id = $1 AND id = $2 AND owner_id = $3',
          [orgId, t.objectId, client.tenant.userId],
        );
        if (!actor.isAdmin && !owner)
          throw new AuthzRuleError('only the owner or admins may manage editors', 'not_owner');
      } else if (!(await canEditContent(client, t.objectId, actor))) {
        throw new AuthzRuleError(
          'only the owner, editors or admins may change the audience',
          'not_author',
        );
      }
      break;
    }
    case 'group':
      if (!actor.isAdmin)
        throw new AuthzRuleError('group membership changes require admin', 'admin_required');
      break;
    case 'stream': {
      const role = await actorStreamRole(client, t.objectId);
      if (!actor.isAdmin && role !== 'owner')
        throw new AuthzRuleError(
          'stream role changes require stream owner or admin',
          'stream_owner_required',
        );
      break;
    }
    default:
      throw new AuthzRuleError('unsupported tuple', 'bad_object');
  }
  await client.query(
    `DELETE FROM relation_tuple WHERE org_id = $1 AND object_type = $2 AND object_id = $3 AND relation = $4 AND subject_type = $5 AND subject_id = $6 AND subject_relation = $7`,
    [orgId, t.objectType, t.objectId, t.relation, t.subjectType, t.subjectId, t.subjectRelation],
  );
}
