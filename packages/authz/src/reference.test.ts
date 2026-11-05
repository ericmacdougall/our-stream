// SPDX-License-Identifier: AGPL-3.0-only
// Unit expectations for the reference implementation on hand-picked matrix cells. These pin the
// ADR-0002 rules independently of the database; the integration matrix then proves SQL agrees.
import { describe, expect, it } from 'vitest';
import { buildFixture, NOW } from './fixture.js';
import { authorAccessible, auditorAccessible, readerVisible } from './reference.js';
import type { OrgSnapshot } from './model.js';

const { users, orgs } = buildFixture();
const [acme, globex] = orgs;
const c = acme.contentNames;

describe('readerVisible (reference)', () => {
  it('company-wide content is visible to active members only', () => {
    expect(readerVisible(acme, users.member!, c.companyPublished, NOW)).toBe(true);
    expect(readerVisible(acme, users.deactivated!, c.companyPublished, NOW)).toBe(false);
    expect(readerVisible(acme, users.outsider!, c.companyPublished, NOW)).toBe(false);
  });
  it('department content follows nested group membership (depth 3) and direct stream roles', () => {
    expect(readerVisible(acme, users.member2!, c.deptPublished, NOW)).toBe(true); // platform ⊂ backend ⊂ engineering
    expect(readerVisible(acme, users.contributor!, c.deptPublished, NOW)).toBe(true);
    expect(readerVisible(acme, users.moderator!, c.deptPublished, NOW)).toBe(true);
    expect(readerVisible(acme, users.member!, c.deptPublished, NOW)).toBe(false);
  });
  it('group audiences respect nesting direction', () => {
    expect(readerVisible(acme, users.member2!, c.groupPublished, NOW)).toBe(true); // backend audience, member2 in platform ⊂ backend
    expect(readerVisible(acme, users.contributor!, c.groupPublished, NOW)).toBe(false); // contributor is in engineering, a parent, not in backend
    expect(readerVisible(acme, users.contributor!, c.nestedGroupPublished, NOW)).toBe(true);
  });
  it('drafts, scheduled, expired, retracted and audience-less content are never reader-visible, even to owners and admins', () => {
    for (const id of [c.draft, c.draftReview, c.scheduled, c.expired, c.retracted, c.noAudience]) {
      for (const who of [
        users.owner!,
        users.admin!,
        users.contributor!,
        users.announcer!,
        users.member!,
      ]) {
        expect(readerVisible(acme, who, id, NOW)).toBe(false);
      }
    }
  });
  it('scheduled content becomes visible once publish_at passes, without any state change', () => {
    expect(
      readerVisible(acme, users.member!, c.scheduled, new Date(NOW.getTime() + 2 * 3_600_000)),
    ).toBe(true);
  });
  it('direct grants and private streams', () => {
    expect(readerVisible(acme, users.member!, c.directPublished, NOW)).toBe(true);
    expect(readerVisible(acme, users.member2!, c.directPublished, NOW)).toBe(false);
    expect(readerVisible(acme, users.privateMember!, c.privatePublished, NOW)).toBe(true);
    expect(readerVisible(acme, users.member!, c.privatePublished, NOW)).toBe(false);
  });
  it('org-wide published content is visible to every active member and to nobody else', () => {
    expect(readerVisible(acme, users.member, c.orgPublished, NOW)).toBe(true);
    expect(readerVisible(acme, users.privateMember, c.orgPublished, NOW)).toBe(true);
    expect(readerVisible(acme, users.deactivated, c.orgPublished, NOW)).toBe(false);
    expect(readerVisible(acme, users.outsider, c.orgPublished, NOW)).toBe(false);
  });
  it('never crosses orgs even for the same user ids', () => {
    expect(readerVisible(globex, users.member!, c.companyPublished, NOW)).toBe(false);
  });
});

describe('authorAccessible (reference)', () => {
  it('drafts: owner, editors and admins only until review is requested', () => {
    expect(authorAccessible(acme, users.contributor!, c.draft)).toBe(true);
    expect(authorAccessible(acme, users.admin!, c.draft)).toBe(true);
    expect(authorAccessible(acme, users.moderator!, c.draft)).toBe(false);
    expect(authorAccessible(acme, users.moderator!, c.draftReview)).toBe(true);
    expect(authorAccessible(acme, users.member!, c.draftReview)).toBe(false);
  });
  it('published items: stream moderators and editors can access', () => {
    expect(authorAccessible(acme, users.moderator!, c.deptPublished)).toBe(true);
    expect(authorAccessible(acme, users.member2!, c.deptPrivateMixed)).toBe(true); // editor
    expect(authorAccessible(acme, users.member!, c.deptPublished)).toBe(false);
    expect(authorAccessible(acme, users.deactivated!, c.deptPublished)).toBe(false);
  });
});

describe('auditorAccessible (reference)', () => {
  it('owner, admin and auditor only', () => {
    expect(auditorAccessible(acme, users.auditor!)).toBe(true);
    expect(auditorAccessible(acme, users.owner!)).toBe(true);
    expect(auditorAccessible(acme, users.member!)).toBe(false);
    expect(auditorAccessible(acme, users.deactivated!)).toBe(false);
  });
});

describe('readerVisible document gate (reference)', () => {
  const docs = buildFixture('-docs', { documents: true });
  const [acme, globex] = docs.orgs;
  const d = acme.documentNames;
  const u = docs.users;

  it('a published document with a current version is visible to its audience when the org flag is on', () => {
    expect(readerVisible(acme, u.member!, d.docCompany!, NOW)).toBe(true);
    expect(readerVisible(acme, u.contributor!, d.docDept!, NOW)).toBe(true);
    expect(readerVisible(acme, u.member!, d.docDirect!, NOW)).toBe(true);
    expect(readerVisible(acme, u.member2!, d.docDirect!, NOW)).toBe(false);
    expect(readerVisible(acme, u.outsider!, d.docCompany!, NOW)).toBe(false);
    expect(readerVisible(acme, u.deactivated!, d.docCompany!, NOW)).toBe(false);
  });

  it('processing, failed, missing-version, draft, scheduled, expired and retracted documents are never visible, owner included', () => {
    for (const k of [
      'docProcessing',
      'docFailed',
      'docNoVersion',
      'docDraftCurrent',
      'docScheduled',
      'docExpired',
      'docRetracted',
    ] as const) {
      for (const who of [u.owner!, u.admin!, u.contributor!, u.member!]) {
        expect(readerVisible(acme, who, d[k]!, NOW), `${k}`).toBe(false);
      }
    }
  });

  it('the flag off, an absent flag (modelled as off) and the kill switch hide every document; clips are unaffected', () => {
    const off: OrgSnapshot = { ...acme, documentsEnabled: false };
    const killed: OrgSnapshot = { ...acme, documentsKillSwitch: true };
    for (const snap of [off, killed, globex]) {
      for (const id of Object.values(d) as string[])
        expect(readerVisible(snap, u.member!, id, NOW)).toBe(false);
      expect(readerVisible(snap, u.member!, acme.contentNames.companyPublished, NOW)).toBe(
        snap === globex ? false : true,
      );
    }
    expect(readerVisible(globex, u.member!, globex.contentNames.companyPublished, NOW)).toBe(true);
  });

  it('a non-vacuous matrix: documents visible to some roles, invisible to others', () => {
    const ids = Object.values(d) as string[];
    const visibleTo = (who: string) => ids.filter((id) => readerVisible(acme, who, id, NOW)).length;
    expect(visibleTo(u.member!)).toBeGreaterThan(0);
    expect(visibleTo(u.contributor!)).toBeGreaterThan(visibleTo(u.member!) - 1);
    expect(visibleTo(u.outsider!)).toBe(0);
  });

  it('broken variant: a predicate that ignores kind and version status would show a processing document', () => {
    const c = acme.content.find((x) => x.id === d.docProcessing)!;
    const withoutGate = (snap: OrgSnapshot) =>
      readerVisible(
        {
          ...snap,
          content: snap.content.map((x) => (x.id === c.id ? { ...x, kind: 'clip' as const } : x)),
        },
        u.member!,
        c.id,
        NOW,
      );
    expect(withoutGate(acme)).toBe(true); // what a missing gate returns
    expect(readerVisible(acme, u.member!, c.id, NOW)).toBe(false);
  });
});
