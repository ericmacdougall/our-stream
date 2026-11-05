// SPDX-License-Identifier: AGPL-3.0-only
// Independent reference implementation of the ADR-0002 rules, written as a plain graph walk over
// tuples. It deliberately shares no code with the SQL generator; the fixture matrix asserts that the
// database and this implementation agree on every cell.
import {
  MAX_GROUP_DEPTH,
  STREAM_ROLE_RANK,
  type OrgSnapshot,
  type StreamRole,
  type Tuple,
} from './model.js';

function isActive(snap: OrgSnapshot, userId: string): boolean {
  return snap.memberships.some((m) => m.userId === userId && m.status === 'active');
}

function orgRole(snap: OrgSnapshot, userId: string) {
  return snap.memberships.find((m) => m.userId === userId)?.role ?? null;
}

/** Groups the user belongs to transitively, bounded by MAX_GROUP_DEPTH. */
export function groupsOf(snap: OrgSnapshot, userId: string): Set<string> {
  const result = new Set<string>();
  let frontier: Array<{ type: 'user' | 'group'; id: string }> = [{ type: 'user', id: userId }];
  for (let depth = 0; depth < MAX_GROUP_DEPTH && frontier.length > 0; depth += 1) {
    const next: Array<{ type: 'user' | 'group'; id: string }> = [];
    for (const f of frontier) {
      for (const t of snap.tuples) {
        if (
          t.objectType === 'group' &&
          t.relation === 'member' &&
          t.subjectType === f.type &&
          t.subjectId === f.id &&
          !result.has(t.objectId)
        ) {
          result.add(t.objectId);
          next.push({ type: 'group', id: t.objectId });
        }
      }
    }
    frontier = next;
  }
  return result;
}

function subjectMatches(snap: OrgSnapshot, t: Tuple, userId: string, groups: Set<string>): boolean {
  if (t.subjectType === 'user') return t.subjectId === userId;
  if (t.subjectType === 'group') return groups.has(t.subjectId);
  if (t.subjectType === 'org') return t.subjectRelation === 'member' && isActive(snap, userId);
  return false;
}

/** Highest stream role the user holds on each stream. */
export function streamRoles(snap: OrgSnapshot, userId: string): Map<string, StreamRole> {
  const groups = groupsOf(snap, userId);
  const roles = new Map<string, StreamRole>();
  if (!isActive(snap, userId)) return roles;
  for (const t of snap.tuples) {
    if (t.objectType !== 'stream' || !(t.relation in STREAM_ROLE_RANK)) continue;
    if (!subjectMatches(snap, t, userId, groups)) continue;
    const role = t.relation as StreamRole;
    const prev = roles.get(t.objectId);
    if (!prev || STREAM_ROLE_RANK[role] > STREAM_ROLE_RANK[prev]) roles.set(t.objectId, role);
  }
  return roles;
}

function audienceTuples(snap: OrgSnapshot, contentId: string): Tuple[] {
  return snap.tuples.filter(
    (t) => t.objectType === 'content' && t.objectId === contentId && t.relation === 'viewer',
  );
}

function hasAudiencePath(snap: OrgSnapshot, userId: string, contentId: string): boolean {
  const groups = groupsOf(snap, userId);
  const roles = streamRoles(snap, userId);
  for (const t of audienceTuples(snap, contentId)) {
    if (t.subjectType === 'user' && t.subjectId === userId) return true;
    if (t.subjectType === 'group' && groups.has(t.subjectId)) return true;
    if (t.subjectType === 'org' && t.subjectRelation === 'member') return true;
    if (t.subjectType === 'stream' && roles.has(t.subjectId)) return true;
  }
  return false;
}

/** readerVisible: the only predicate for reader paths (feed, search, retrieval, media, notifications). */
export function readerVisible(
  snap: OrgSnapshot,
  userId: string,
  contentId: string,
  now: Date,
): boolean {
  if (!isActive(snap, userId)) return false;
  const c = snap.content.find((x) => x.id === contentId);
  if (!c) return false;
  if (c.state !== 'published') return false;
  if (c.retractedAt !== null) return false;
  // Document gate (M2a): a document is reader-visible only while documents are enabled for the org and
  // the content's current version is `current` (a processing or failed version never is).
  if (c.kind === 'document') {
    if (!snap.documentsEnabled || snap.documentsKillSwitch) return false;
    if (c.currentVersionStatus !== 'current') return false;
  }
  if (c.publishAt === null || c.publishAt.getTime() > now.getTime()) return false;
  if (c.expiresAt !== null && c.expiresAt.getTime() <= now.getTime()) return false;
  return hasAudiencePath(snap, userId, contentId);
}

/** authorAccessible: editing, moderation and processing-status endpoints only. */
export function authorAccessible(snap: OrgSnapshot, userId: string, contentId: string): boolean {
  if (!isActive(snap, userId)) return false;
  const c = snap.content.find((x) => x.id === contentId);
  if (!c) return false;
  const role = orgRole(snap, userId);
  if (c.ownerId === userId) return true;
  if (role === 'owner' || role === 'admin') return true;
  const isEditor = snap.tuples.some(
    (t) =>
      t.objectType === 'content' &&
      t.objectId === contentId &&
      t.relation === 'editor' &&
      t.subjectType === 'user' &&
      t.subjectId === userId,
  );
  if (isEditor) return true;
  if (c.state === 'draft' && !c.reviewRequested) return false;
  const roles = streamRoles(snap, userId);
  for (const t of audienceTuples(snap, contentId)) {
    if (t.subjectType !== 'stream') continue;
    const r = roles.get(t.subjectId);
    if (r === 'moderator' || r === 'owner') return true;
  }
  return false;
}

/** auditorAccessible: audited path for old versions and retracted content. */
export function auditorAccessible(snap: OrgSnapshot, userId: string): boolean {
  if (!isActive(snap, userId)) return false;
  const role = orgRole(snap, userId);
  return role === 'owner' || role === 'admin' || role === 'auditor';
}
