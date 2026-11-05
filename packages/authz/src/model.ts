// SPDX-License-Identifier: AGPL-3.0-only
// Authorization model types (ADR-0002). Tuples are Zanzibar-shaped: (object, relation, subject[#relation]).

export type ObjectType = 'org' | 'group' | 'stream' | 'content';
export type SubjectType = 'user' | 'group' | 'stream' | 'org';

export type OrgRole = 'owner' | 'admin' | 'announcer' | 'contributor' | 'member' | 'auditor';
export type StreamRole = 'viewer' | 'contributor' | 'moderator' | 'owner';
export type ContentState = 'draft' | 'published' | 'retracted';
export type ContentKind = 'clip' | 'audio' | 'document';
export type VersionStatus =
  'uploaded' | 'processing' | 'current' | 'superseded' | 'retracted' | 'failed';

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
  kind: ContentKind;
  /** Status of the version content.current_version_id points at; null when there is no current version row. */
  currentVersionStatus: VersionStatus | null;
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
  /** Org flag `documents_enabled` (an absent key is false). */
  documentsEnabled: boolean;
  /** Deployment kill switch (platform.documents_kill_switch); true overrides every org flag. */
  documentsKillSwitch: boolean;
}

export const STREAM_ROLE_RANK: Record<StreamRole, number> = {
  viewer: 1,
  contributor: 2,
  moderator: 3,
  owner: 4,
};
export const MAX_GROUP_DEPTH = 4;
