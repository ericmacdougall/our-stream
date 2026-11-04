// SPDX-License-Identifier: AGPL-3.0-only
// Event tags and pins: a closed enum enforced by the database, edits limited to owner/admin/announcer
// authors, pins limited to announcers/admins (org) and stream moderators (stream), and feed filters
// that only ever narrow the reader-visible set.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  createPlayableContent,
  createStream,
  integrationReady,
  type Harness,
  type Session,
} from './test-harness.js';

const code = (body: unknown) => (body as { error: { code: string } }).error.code;
interface FeedBody {
  items: Array<{ id: string; tags: string[]; pinned: boolean }>;
}

describe.skipIf(!integrationReady)('tags, pins and feed filters (integration)', () => {
  let h: Harness;
  let owner: Session;
  let announcer: Session;
  let author: Session; // contributor
  let member: Session; // dept viewer
  let moderator: Session; // dept moderator
  let outsider: Session; // no dept access
  let dept: string;
  let deptClip: string; // by author, to dept
  let orgClip: string; // by announcer, to everyone

  const feed = async (s: Session, qs = '') =>
    (await h.call('GET', `/v1/feed?limit=50${qs}`, s)).body as FeedBody;
  const ids = (f: FeedBody) => f.items.map((i) => i.id).sort();

  beforeAll(async () => {
    h = await createHarness('pins');
    owner = await h.signup('owner', 'acme');
    announcer = await h.invite(owner, 'announcer', 'announcer');
    author = await h.invite(owner, 'author', 'contributor');
    member = await h.invite(owner, 'member', 'member');
    moderator = await h.invite(owner, 'moderator', 'member');
    outsider = await h.invite(owner, 'outsider', 'member');
    dept = await createStream(h, owner, 'dept', 'department', [
      { session: author, role: 'contributor' },
      { session: member, role: 'viewer' },
      { session: moderator, role: 'moderator' },
    ]);
    deptClip = (await createPlayableContent(h, author, 'Dept clip')).contentId;
    orgClip = (await createPlayableContent(h, announcer, 'Org clip')).contentId;
    for (const [id, s, audience] of [
      [deptClip, author, [{ type: 'stream', streamId: dept }]],
      [orgClip, announcer, [{ type: 'everyone' }]],
    ] as const) {
      const r = await h.call('POST', `/v1/content/${id}/publish`, s, { audience });
      if (r.status !== 200) throw new Error(`publish failed: ${r.raw}`);
    }
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('tags: closed enum, set by owner/admin/announcer authors only, enforced by the database too', async () => {
    const byAuthor = await h.call('PUT', `/v1/content/${deptClip}/tags`, author, {
      tags: ['training'],
    });
    expect(byAuthor.status).toBe(403);
    expect(code(byAuthor.body)).toBe('role_forbidden');
    // The announcer has the role but no author access to the contributor's clip.
    const noAccess = await h.call('PUT', `/v1/content/${deptClip}/tags`, announcer, {
      tags: ['training'],
    });
    expect(noAccess.status).toBe(404);
    expect(code(noAccess.body)).toBe('content_not_found');
    const byMember = await h.call('PUT', `/v1/content/${deptClip}/tags`, member, {
      tags: ['training'],
    });
    expect(byMember.status).toBe(403);
    expect(code(byMember.body)).toBe('role_forbidden');
    expect(
      (await h.call('PUT', `/v1/content/${deptClip}/tags`, owner, { tags: ['nope'] })).status,
    ).toBe(400);
    expect(
      (
        await h.call('PUT', `/v1/content/${deptClip}/tags`, owner, {
          tags: ['training', 'training'],
        })
      ).status,
    ).toBe(400);
    const set = await h.call('PUT', `/v1/content/${deptClip}/tags`, owner, {
      tags: ['training', 'onboarding'],
    });
    expect(set.status).toBe(200);
    expect((set.body as { tags: string[] }).tags).toEqual(['training', 'onboarding']);
    const own = await h.call('PUT', `/v1/content/${orgClip}/tags`, announcer, {
      tags: ['announcement'],
    });
    expect(own.status).toBe(200);
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [owner.orgId]);
    await expect(
      h.admin.query(
        `UPDATE content SET event_tags = '{training,bogus}' WHERE org_id = $1 AND id = $2`,
        [owner.orgId, deptClip],
      ),
    ).rejects.toThrow(/event_tags/);
    await h.admin.query(`SELECT set_config('app.org_id', '', false)`);
  });

  it('feed tag filter narrows and never widens', async () => {
    const all = await feed(member);
    expect(ids(all)).toEqual([deptClip, orgClip].sort());
    expect(all.items.find((i) => i.id === deptClip)!.tags).toEqual(['training', 'onboarding']);
    expect(ids(await feed(member, '&tag=training'))).toEqual([deptClip]);
    expect(ids(await feed(member, '&tag=announcement'))).toEqual([orgClip]);
    expect(ids(await feed(member, '&tag=current-events'))).toEqual([]);
    expect((await h.call('GET', '/v1/feed?tag=bogus', member)).status).toBe(400);
    // The outsider cannot see the dept clip, tagged or not.
    expect(ids(await feed(outsider, '&tag=training'))).toEqual([]);
    expect(ids(await feed(outsider))).toEqual([orgClip]);
  });

  it("pins: org pins by announcers/admins, stream pins by that stream's moderators, never widening visibility", async () => {
    const byMember = await h.call('POST', `/v1/content/${deptClip}/pin`, member, {
      streamId: dept,
    });
    expect(byMember.status).toBe(403);
    expect(code(byMember.body)).toBe('pin_forbidden');
    expect((await h.call('POST', `/v1/content/${deptClip}/pin`, author, {})).status).toBe(403);
    expect((await h.call('POST', `/v1/content/${deptClip}/pin`, moderator, {})).status).toBe(403); // org scope needs announcer+
    const wrongStream = await h.call('POST', `/v1/content/${orgClip}/pin`, moderator, {
      streamId: dept,
    });
    expect(wrongStream.status).toBe(409);
    expect(code(wrongStream.body)).toBe('not_in_audience');
    const before = (await h.call('GET', `/v1/content/${deptClip}`, member)).body as {
      contentEpoch: number;
      pinned: boolean;
    };
    expect(before.pinned).toBe(false);
    const streamPin = await h.call('POST', `/v1/content/${deptClip}/pin`, moderator, {
      streamId: dept,
    });
    expect(streamPin.status).toBe(200);
    expect(streamPin.body).toMatchObject({ id: deptClip, pinned: true });
    expect((streamPin.body as { contentEpoch: number }).contentEpoch).toBeGreaterThan(
      before.contentEpoch,
    );
    expect(
      (await h.call('POST', `/v1/content/${deptClip}/pin`, moderator, { streamId: dept })).status,
    ).toBe(200);
    const orgPin = await h.call('POST', `/v1/content/${orgClip}/pin`, announcer, {});
    expect(orgPin.status).toBe(200);
    const draft = await h.call('POST', '/v1/content', announcer, { kind: 'clip', title: 'Draft' });
    const draftPin = await h.call(
      'POST',
      `/v1/content/${(draft.body as { id: string }).id}/pin`,
      announcer,
      {},
    );
    expect(draftPin.status).toBe(409);
    expect(code(draftPin.body)).toBe('not_published');

    const memberFeed = await feed(member);
    expect(memberFeed.items.every((i) => i.pinned)).toBe(true);
    expect(ids(await feed(member, '&pinned=true'))).toEqual([deptClip, orgClip].sort());
    expect(ids(await feed(member, `&pinned=true&streamId=${dept}`))).toEqual([deptClip]);
    expect(ids(await feed(member, '&pinned=false'))).toEqual([deptClip, orgClip].sort()); // `false` is no filter
    // The outsider never sees the dept pin, with or without the filter.
    expect(ids(await feed(outsider, '&pinned=true'))).toEqual([orgClip]);
    expect(ids(await feed(outsider, `&pinned=true&streamId=${dept}`))).toEqual([]);

    const unpin = await h.call('DELETE', `/v1/content/${deptClip}/pin?streamId=${dept}`, moderator);
    expect(unpin.status).toBe(200);
    expect(unpin.body).toMatchObject({ pinned: false });
    expect(
      (await h.call('DELETE', `/v1/content/${deptClip}/pin?streamId=${dept}`, moderator)).status,
    ).toBe(200);
    expect((await h.call('DELETE', `/v1/content/${orgClip}/pin`, member)).status).toBe(403);
    expect(ids(await feed(member, '&pinned=true'))).toEqual([orgClip]);
  });
});
