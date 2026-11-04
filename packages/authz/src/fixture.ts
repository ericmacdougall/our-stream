// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic fixture matrix (ADR-0002 tests): two orgs with overlapping users, nested groups,
// company/department/private streams, every content state and audience kind. Seeded into Postgres
// by the integration test and evaluated by the reference implementation.
import { randomUUID } from 'node:crypto';
import type { ContentRow, GroupRow, Membership, OrgRole, OrgSnapshot, Tuple } from './model.js';

export const NOW = new Date('2026-11-03T12:00:00Z');
const HOUR = 3_600_000;

export const USER_NAMES = [
  'owner',
  'admin',
  'announcer',
  'contributor',
  'member',
  'member2',
  'auditor',
  'deactivated',
  'moderator',
  'privateMember',
  'outsider',
] as const;
export type UserName = (typeof USER_NAMES)[number];
export type FixtureUsers = Record<UserName, string>;

export type GroupName = 'engineering' | 'backend' | 'platform' | 'secret';
export type StreamName = 'company' | 'department' | 'private';
export type ContentName =
  | 'companyPublished'
  | 'deptPublished'
  | 'privatePublished'
  | 'groupPublished'
  | 'directPublished'
  | 'draft'
  | 'draftReview'
  | 'scheduled'
  | 'expired'
  | 'retracted'
  | 'nestedGroupPublished'
  | 'noAudience'
  | 'deptPrivateMixed'
  | 'orgPublished';

export interface FixtureOrg extends OrgSnapshot {
  slug: string;
  users: FixtureUsers;
  groups: GroupRow[];
  groupNames: Record<GroupName, string>;
  streamNames: Record<StreamName, string>;
  contentNames: Record<ContentName, string>;
}

function tuple(
  objectType: Tuple['objectType'],
  objectId: string,
  relation: string,
  subjectType: Tuple['subjectType'],
  subjectId: string,
  subjectRelation = '',
): Tuple {
  return { objectType, objectId, relation, subjectType, subjectId, subjectRelation };
}

export function buildOrg(slug: string, userIds: FixtureUsers): FixtureOrg {
  const orgId = randomUUID();
  const u = userIds;
  const roles: Partial<Record<UserName, OrgRole>> = {
    owner: 'owner',
    admin: 'admin',
    announcer: 'announcer',
    contributor: 'contributor',
    member: 'member',
    member2: 'member',
    auditor: 'auditor',
    deactivated: 'member',
    moderator: 'contributor',
    privateMember: 'member',
  };
  const memberships: Membership[] = (Object.entries(roles) as Array<[UserName, OrgRole]>).map(
    ([name, role]) => ({
      userId: u[name],
      role,
      status: name === 'deactivated' ? 'deactivated' : 'active',
    }),
  );

  const groupNames: Record<GroupName, string> = {
    engineering: randomUUID(),
    backend: randomUUID(),
    platform: randomUUID(),
    secret: randomUUID(),
  };
  const groups: GroupRow[] = [
    { id: groupNames.engineering, isPrivate: false },
    { id: groupNames.backend, isPrivate: false },
    { id: groupNames.platform, isPrivate: false },
    { id: groupNames.secret, isPrivate: true },
  ];
  const streamNames: Record<StreamName, string> = {
    company: randomUUID(),
    department: randomUUID(),
    private: randomUUID(),
  };
  const contentNames: Record<ContentName, string> = {
    companyPublished: randomUUID(),
    deptPublished: randomUUID(),
    privatePublished: randomUUID(),
    groupPublished: randomUUID(),
    directPublished: randomUUID(),
    draft: randomUUID(),
    draftReview: randomUUID(),
    scheduled: randomUUID(),
    expired: randomUUID(),
    retracted: randomUUID(),
    nestedGroupPublished: randomUUID(),
    noAudience: randomUUID(),
    deptPrivateMixed: randomUUID(),
    orgPublished: randomUUID(),
  };

  const tuples: Tuple[] = [
    // groups: engineering ⊃ backend ⊃ platform; member2 in platform (depth 3 via nesting)
    tuple('group', groupNames.backend, 'member', 'group', groupNames.platform),
    tuple('group', groupNames.engineering, 'member', 'group', groupNames.backend),
    tuple('group', groupNames.platform, 'member', 'user', u.member2!),
    tuple('group', groupNames.engineering, 'member', 'user', u.contributor!),
    tuple('group', groupNames.secret, 'member', 'user', u.privateMember!),
    // streams
    tuple('stream', streamNames.company, 'viewer', 'org', orgId, 'member'),
    tuple('stream', streamNames.company, 'contributor', 'user', u.contributor!),
    tuple('stream', streamNames.company, 'owner', 'user', u.owner!),
    tuple('stream', streamNames.department, 'viewer', 'group', groupNames.engineering),
    tuple('stream', streamNames.department, 'moderator', 'user', u.moderator!),
    tuple('stream', streamNames.department, 'contributor', 'user', u.contributor!),
    tuple('stream', streamNames.private, 'viewer', 'user', u.privateMember!),
    tuple('stream', streamNames.private, 'owner', 'user', u.admin!),
    // audiences
    tuple(
      'content',
      contentNames.companyPublished,
      'viewer',
      'stream',
      streamNames.company,
      'viewer',
    ),
    tuple(
      'content',
      contentNames.deptPublished,
      'viewer',
      'stream',
      streamNames.department,
      'viewer',
    ),
    tuple(
      'content',
      contentNames.privatePublished,
      'viewer',
      'stream',
      streamNames.private,
      'viewer',
    ),
    tuple('content', contentNames.groupPublished, 'viewer', 'group', groupNames.backend),
    tuple('content', contentNames.nestedGroupPublished, 'viewer', 'group', groupNames.engineering),
    tuple('content', contentNames.directPublished, 'viewer', 'user', u.member!),
    tuple('content', contentNames.draft, 'viewer', 'stream', streamNames.department, 'viewer'),
    tuple(
      'content',
      contentNames.draftReview,
      'viewer',
      'stream',
      streamNames.department,
      'viewer',
    ),
    tuple('content', contentNames.scheduled, 'viewer', 'org', orgId, 'member'),
    tuple('content', contentNames.orgPublished, 'viewer', 'org', orgId, 'member'),
    tuple('content', contentNames.expired, 'viewer', 'org', orgId, 'member'),
    tuple('content', contentNames.retracted, 'viewer', 'org', orgId, 'member'),
    tuple(
      'content',
      contentNames.deptPrivateMixed,
      'viewer',
      'stream',
      streamNames.department,
      'viewer',
    ),
    tuple('content', contentNames.deptPrivateMixed, 'viewer', 'group', groupNames.secret),
    tuple('content', contentNames.deptPrivateMixed, 'editor', 'user', u.member2!),
  ];

  const base = (id: string, owner: string, over: Partial<ContentRow> = {}): ContentRow => ({
    id,
    ownerId: owner,
    state: 'published',
    publishAt: new Date(NOW.getTime() - HOUR),
    expiresAt: null,
    retractedAt: null,
    reviewRequested: false,
    ...over,
  });
  const content: ContentRow[] = [
    base(contentNames.companyPublished, u.announcer!),
    base(contentNames.deptPublished, u.contributor!),
    base(contentNames.privatePublished, u.admin!),
    base(contentNames.groupPublished, u.admin!),
    base(contentNames.nestedGroupPublished, u.admin!),
    base(contentNames.directPublished, u.contributor!),
    base(contentNames.draft, u.contributor!, { state: 'draft', publishAt: null }),
    base(contentNames.draftReview, u.contributor!, {
      state: 'draft',
      publishAt: null,
      reviewRequested: true,
    }),
    base(contentNames.scheduled, u.announcer!, { publishAt: new Date(NOW.getTime() + HOUR) }),
    base(contentNames.expired, u.announcer!, { expiresAt: new Date(NOW.getTime() - 1000) }),
    base(contentNames.retracted, u.announcer!, {
      state: 'retracted',
      retractedAt: new Date(NOW.getTime() - 1000),
    }),
    base(contentNames.noAudience, u.contributor!),
    base(contentNames.deptPrivateMixed, u.contributor!),
    base(contentNames.orgPublished, u.announcer),
  ];

  return {
    orgId,
    slug,
    memberships,
    groups,
    groupNames,
    streams: Object.values(streamNames),
    streamNames,
    tuples,
    content,
    contentNames,
    users: userIds,
  };
}

/** Two orgs sharing the same user accounts (overlapping emails) so cross-org leaks are testable. */
/** `suffix` keeps concurrently running suites from sharing org slugs. */
export function buildFixture(suffix = ''): { users: FixtureUsers; orgs: [FixtureOrg, FixtureOrg] } {
  const users = Object.fromEntries(USER_NAMES.map((n) => [n, randomUUID()])) as FixtureUsers;
  return { users, orgs: [buildOrg(`acme${suffix}`, users), buildOrg(`globex${suffix}`, users)] };
}
