// SPDX-License-Identifier: AGPL-3.0-only
// Unit expectations for the reference implementation on hand-picked matrix cells. These pin the
// ADR-0002 rules independently of the database; the integration matrix then proves SQL agrees.
import { describe, expect, it } from 'vitest';
import { buildFixture, NOW } from './fixture.js';
import { authorAccessible, auditorAccessible, readerVisible } from './reference.js';

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
