// SPDX-License-Identifier: AGPL-3.0-only
// Authorization model types (ADR-0002). Tuples are Zanzibar-shaped: (object, relation, subject[#relation]).

export type ObjectType = 'org' | 'group' | 'stream' | 'content';
export type SubjectType = 'user' | 'group' | 'stream' | 'org';

export type OrgRole = 'owner' | 'admin' | 'announcer' | 'contributor' | 'member' | 'auditor';
export type StreamRole = 'viewer' | 'contributor' | 'moderator' | 'owner';
export type ContentState = 'draft' | 'published' | 'retracted';

export interface Tuple {
  objectType: ObjectType;
  objectId: string;
  relation: string;
  subjectType: SubjectType;
  subjectId: string;
  /** For userset subjects, e.g. stream#viewer or org#member. Empty string for plain subjects. */
  subjectRelation: string;
}

export interface Membership {
  userId: string;
  role: OrgRole;
  status: 'active' | 'deactivated';
}

export interface ContentRow {
  id: string;
  ownerId: string;
  state: ContentState;
  publishAt: Date | null;
  expiresAt: Date | null;
  retractedAt: Date | null;
  reviewRequested: boolean;
}

export interface GroupRow {
  id: string;
  isPrivate: boolean;
}

/** A complete picture of one org, as the reference implementation sees it. */
export interface OrgSnapshot {
  orgId: string;
  memberships: Membership[];
  groups: GroupRow[];
  streams: string[];
  tuples: Tuple[];
  content: ContentRow[];
}

export const STREAM_ROLE_RANK: Record<StreamRole, number> = {
  viewer: 1,
  contributor: 2,
  moderator: 3,
  owner: 4,
};
export const MAX_GROUP_DEPTH = 4;
