// SPDX-License-Identifier: AGPL-3.0-only
// Reactions, comments, moderation and share-as-link: idempotent under double submit and concurrency,
// gated by readerVisible (retracted/expired/draft content answers 404), moderation limited to admins
// and audience-stream moderators and always audited.
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

interface CommentDto {
  id: string;
  parentId: string | null;
  author: { id: string; displayName: string } | null;
  body: string | null;
  state: string;
  reportCount?: number;
  canRemove: boolean;
  replies?: CommentDto[];
  replyCount?: number;
}
interface ListDto {
  items: CommentDto[];
  nextCursor: string | null;
  commentsEnabled: boolean;
  canModerate: boolean;
}

describe.skipIf(!integrationReady)('reactions, comments, share (integration)', () => {
  let h: Harness;
  let owner: Session;
  let author: Session; // contributor, owns the clip, not a moderator
  let viewer: Session; // member with dept viewer role
  let viewer2: Session; // member with dept viewer role
  let moderator: Session; // member with dept moderator role
  let outsider: Session; // active member without dept access
  let dept: string;
  let contentId: string;
  let versionId: string;

  beforeAll(async () => {
    h = await createHarness('react', { COMMENT_RATE_LIMIT_MAX: '1000' });
    owner = await h.signup('owner', 'acme');
    author = await h.invite(owner, 'author', 'contributor');
    viewer = await h.invite(owner, 'viewer', 'member');
    viewer2 = await h.invite(owner, 'viewer2', 'member');
    moderator = await h.invite(owner, 'moderator', 'member');
    outsider = await h.invite(owner, 'outsider', 'member');
    dept = await createStream(h, owner, 'dept', 'department', [
      { session: author, role: 'contributor' },
      { session: viewer, role: 'viewer' },
      { session: viewer2, role: 'viewer' },
      { session: moderator, role: 'moderator' },
    ]);
    ({ contentId, versionId } = await createPlayableContent(h, author, 'Budget talk'));
    const pub = await h.call('POST', `/v1/content/${contentId}/publish`, author, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    if (pub.status !== 200) throw new Error(`publish failed: ${pub.raw}`);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('like and unlike are idempotent under double submit and concurrency; invisible content is 404', async () => {
    const first = await h.call('POST', `/v1/content/${contentId}/like`, viewer);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ liked: true, likeCount: 1 });
    const again = await h.call('POST', `/v1/content/${contentId}/like`, viewer);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ liked: true, likeCount: 1 });
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => h.call('POST', `/v1/content/${contentId}/like`, viewer2)),
    );
    expect(burst.every((r) => r.status === 200)).toBe(true);
    const rows = await h.admin.query(
      `SELECT count(*)::int AS n FROM reaction WHERE content_id = $1 AND user_id = $2`,
      [contentId, viewer2.userId],
    );
    expect(rows.rows[0]!.n).toBe(1);
    expect((await h.call('GET', `/v1/content/${contentId}`, viewer)).body).toMatchObject({
      liked: true,
      likeCount: 2,
      media: { hls: `/media/${contentId}/${versionId}/hls/master.m3u8` },
    });
    // A draft has no playable media on its detail, even for its author.
    const draft = await h.call('POST', '/v1/content', author, { kind: 'clip', title: 'Draft' });
    expect((draft.body as { media: unknown }).media).toBeNull();
    const un = await h.call('DELETE', `/v1/content/${contentId}/like`, viewer2);
    expect(un.body).toEqual({ liked: false, likeCount: 1 });
    expect((await h.call('DELETE', `/v1/content/${contentId}/like`, viewer2)).body).toEqual({
      liked: false,
      likeCount: 1,
    });
    const denied = await h.call('POST', `/v1/content/${contentId}/like`, outsider);
    expect(denied.status).toBe(404);
    expect(code(denied.body)).toBe('content_not_found');
    const feed = (await h.call('GET', '/v1/feed', viewer)).body as {
      items: Array<{ id: string; liked: boolean; likeCount: number; commentCount: number }>;
    };
    expect(feed.items.find((i) => i.id === contentId)).toMatchObject({
      liked: true,
      likeCount: 1,
      commentCount: 0,
    });
  });

  it('threads: roots, replies attach to the root, listing is reader-only and cursor-paginated', async () => {
    const denied = await h.call('POST', `/v1/content/${contentId}/comments`, outsider, {
      body: 'hi',
    });
    expect(denied.status).toBe(404);
    expect(code(denied.body)).toBe('content_not_found');
    const deniedList = await h.call('GET', `/v1/content/${contentId}/comments`, outsider);
    expect(deniedList.status).toBe(404);
    expect(code(deniedList.body)).toBe('content_not_found');
    const root = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: 'Great summary',
      clientKey: 'k-root',
    });
    expect(root.status).toBe(200);
    const rootId = (root.body as CommentDto).id;
    const replay = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: 'Great summary',
      clientKey: 'k-root',
    });
    expect(replay.status).toBe(200);
    expect((replay.body as CommentDto).id).toBe(rootId);
    // Same key, different body: the client is confused, not retrying.
    const mismatch = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: 'Something else',
      clientKey: 'k-root',
    });
    expect(mismatch.status).toBe(409);
    expect(code(mismatch.body)).toBe('idempotency_mismatch');
    // The key is scoped to the item: the same key on another clip writes a new comment there.
    const other = await createPlayableContent(h, author, 'Other clip');
    await h.call('POST', `/v1/content/${other.contentId}/publish`, author, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    const onOther = await h.call('POST', `/v1/content/${other.contentId}/comments`, viewer, {
      body: 'Different clip',
      clientKey: 'k-root',
    });
    expect(onOther.status).toBe(200);
    expect((onOther.body as CommentDto).id).not.toBe(rootId);
    // A parent from another clip is not a parent here.
    const crossParent = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: 'x',
      parentId: (onOther.body as CommentDto).id,
    });
    expect(crossParent.status).toBe(404);
    expect(code(crossParent.body)).toBe('bad_parent');
    const burst = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.call('POST', `/v1/content/${contentId}/comments`, viewer2, {
          body: 'double click',
          clientKey: 'k-burst',
        }),
      ),
    );
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect(new Set(burst.map((r) => (r.body as CommentDto).id)).size).toBe(1);

    const reply = await h.call('POST', `/v1/content/${contentId}/comments`, author, {
      body: 'Thanks!',
      parentId: rootId,
    });
    expect(reply.status).toBe(200);
    const replyId = (reply.body as CommentDto).id;
    const nested = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: 'Welcome',
      parentId: replyId,
    });
    expect(nested.status).toBe(200);
    expect((nested.body as CommentDto).parentId).toBe(rootId);
    const badParent = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: 'x',
      parentId: '00000000-0000-4000-8000-000000000000',
    });
    expect(badParent.status).toBe(404);
    expect(code(badParent.body)).toBe('bad_parent');

    const list = (await h.call('GET', `/v1/content/${contentId}/comments?limit=1`, viewer))
      .body as ListDto;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.id).toBe(rootId);
    expect(list.items[0]!.replies!.map((r) => r.body)).toEqual(['Thanks!', 'Welcome']);
    expect(list.items[0]!.replyCount).toBe(2);
    expect(list.items[0]!.canRemove).toBe(true); // own comment
    expect(list.items[0]!.reportCount).toBeUndefined(); // not a moderator
    expect(list.commentsEnabled).toBe(true);
    expect(list.canModerate).toBe(false);
    expect(list.nextCursor).not.toBeNull();
    const page2 = (
      await h.call(
        'GET',
        `/v1/content/${contentId}/comments?limit=1&cursor=${encodeURIComponent(list.nextCursor!)}`,
        viewer,
      )
    ).body as ListDto;
    expect(page2.items.map((c) => c.body)).toEqual(['double click']);
    expect(page2.nextCursor).toBeNull();
    const detail = (await h.call('GET', `/v1/content/${contentId}`, viewer)).body as {
      commentCount: number;
    };
    expect(detail.commentCount).toBe(4);
    const events = await h.admin.query(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'comment.created' AND subject_id = $1`,
      [contentId],
    );
    expect(events.rows[0]!.n).toBe(4);
  });

  it('bodies are NFC-normalised, control and bidi characters stripped, empty and oversized refused, markup stored verbatim', async () => {
    const r = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: 'cafe\u0301 \u0007done\u200B\u202E <img src=x onerror=alert(1)>\n\t👩\u200D💻 ok\uFEFF',
    });
    expect(r.status).toBe(200);
    expect((r.body as CommentDto).body).toBe(
      'café done <img src=x onerror=alert(1)>\n\t👩\u200D💻 ok',
    );
    const empty = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: ' \u0007\u200B ',
    });
    expect(empty.status).toBe(400);
    expect(code(empty.body)).toBe('empty_body');
    expect(
      (
        await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
          body: 'x'.repeat(2001),
        })
      ).status,
    ).toBe(400);
    // The 2000 cap applies after normalisation: 2000 decomposed pairs collapse to 1000 characters.
    expect(
      (
        await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
          body: 'e\u0301'.repeat(1000),
        })
      ).status,
    ).toBe(200);
  });

  it('the comment scanner blocks secrets under policy block and only names the finding category', async () => {
    const r = await h.call('PATCH', '/v1/org/settings', owner, { commentScanPolicy: 'block' });
    expect(r.status).toBe(200);
    const blocked = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: 'use AKIAIOSFODNN7EXAMPLE to log in',
    });
    expect(blocked.status).toBe(400);
    expect(code(blocked.body)).toBe('comment_blocked');
    expect(blocked.raw).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(blocked.raw).toContain('secret');
    await h.call('PATCH', '/v1/org/settings', owner, { commentScanPolicy: 'off' });
    expect(
      (
        await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
          body: 'use AKIAIOSFODNN7EXAMPLE',
        })
      ).status,
    ).toBe(200);
  });

  it('reports are idempotent and visible to moderators only; removal is limited and audited', async () => {
    const list = (await h.call('GET', `/v1/content/${contentId}/comments?limit=50`, moderator))
      .body as ListDto;
    expect(list.canModerate).toBe(true);
    const target = list.items.find((c) => c.body === 'double click')!;
    expect(
      (await h.call('POST', `/v1/comments/${target.id}/report`, viewer, { reason: 'spam' })).status,
    ).toBe(200);
    expect(
      (await h.call('POST', `/v1/comments/${target.id}/report`, viewer, { reason: 'spam again' }))
        .status,
    ).toBe(200);
    expect((await h.call('POST', `/v1/comments/${target.id}/report`, outsider, {})).status).toBe(
      404,
    );
    const asMod = (await h.call('GET', `/v1/content/${contentId}/comments?limit=50`, moderator))
      .body as ListDto;
    expect(asMod.items.find((c) => c.id === target.id)!.reportCount).toBe(1);
    expect(asMod.items.find((c) => c.id === target.id)!.canRemove).toBe(true);
    const asViewer = (await h.call('GET', `/v1/content/${contentId}/comments?limit=50`, viewer))
      .body as ListDto;
    expect(asViewer.items.find((c) => c.id === target.id)!.reportCount).toBeUndefined();
    expect(asViewer.items.find((c) => c.id === target.id)!.canRemove).toBe(false);

    // Neither another viewer nor the content owner (a contributor, not a moderator) may remove it.
    const byViewer = await h.call('POST', `/v1/comments/${target.id}/remove`, viewer, {
      reason: 'x',
    });
    expect(byViewer.status).toBe(403);
    expect(code(byViewer.body)).toBe('moderation_forbidden');
    expect((await h.call('POST', `/v1/comments/${target.id}/remove`, author, {})).status).toBe(403);
    expect((await h.call('POST', `/v1/comments/${target.id}/remove`, outsider, {})).status).toBe(
      404,
    );

    const removed = await h.call('POST', `/v1/comments/${target.id}/remove`, moderator, {
      reason: 'spam',
    });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({
      id: target.id,
      state: 'removed',
      body: null,
      author: null,
    });
    expect(
      (await h.call('POST', `/v1/comments/${target.id}/remove`, moderator, { reason: 'spam' }))
        .status,
    ).toBe(200);
    const audit = await h.admin.query<{
      actor_id: string;
      target: { commentId: string; reason: string };
    }>(
      `SELECT actor_id, target FROM audit_event WHERE org_id = $1 AND action = 'comment.removed' AND target->>'commentId' = $2`,
      [owner.orgId, target.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor_id).toBe(moderator.userId);
    expect(audit.rows[0]!.target.reason).toBe('spam');
    const after = (await h.call('GET', `/v1/content/${contentId}/comments?limit=50`, viewer))
      .body as ListDto;
    const tomb = after.items.find((c) => c.id === target.id)!;
    expect(tomb).toMatchObject({ state: 'removed', body: null, author: null });
    expect(JSON.stringify(after)).not.toContain('double click');

    // An author removes their own comment; the org owner (admin role) can remove anyone's.
    const own = await h.call('POST', `/v1/content/${contentId}/comments`, viewer2, {
      body: 'oops',
    });
    expect(
      (await h.call('POST', `/v1/comments/${(own.body as CommentDto).id}/remove`, viewer2, {}))
        .status,
    ).toBe(200);
    const other = await h.call('POST', `/v1/content/${contentId}/comments`, viewer2, {
      body: 'rude',
    });
    expect(
      (
        await h.call('POST', `/v1/comments/${(other.body as CommentDto).id}/remove`, owner, {
          reason: 'conduct',
        })
      ).status,
    ).toBe(200);
    // Removing a reply keeps the thread shape (tombstone) but no longer counts it.
    const threads = (await h.call('GET', `/v1/content/${contentId}/comments?limit=50`, viewer))
      .body as ListDto;
    const root = threads.items.find((c) => c.body === 'Great summary')!;
    expect(root.replyCount).toBe(2);
    const welcome = root.replies!.find((r) => r.body === 'Welcome')!;
    expect((await h.call('POST', `/v1/comments/${welcome.id}/remove`, viewer, {})).status).toBe(
      200,
    );
    const afterReply = (await h.call('GET', `/v1/content/${contentId}/comments?limit=50`, viewer))
      .body as ListDto;
    const rootAfter = afterReply.items.find((c) => c.id === root.id)!;
    expect(rootAfter.replyCount).toBe(1);
    expect(rootAfter.replies!.find((r) => r.id === welcome.id)).toMatchObject({
      state: 'removed',
      body: null,
    });
    const commentCount = (await h.call('GET', `/v1/content/${contentId}`, viewer)).body as {
      commentCount: number;
    };
    expect(commentCount.commentCount).toBe(5); // root, 1 visible reply, café, decomposed-pairs, AKIA (allowed under off); tombstones are not counted
  });

  it('comments can be disabled per stream by the owner and refused with 409', async () => {
    const off = await h.call('PATCH', `/v1/streams/${dept}`, owner, { commentsEnabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id: dept, commentsEnabled: false });
    expect(
      (await h.call('PATCH', `/v1/streams/${dept}`, viewer, { commentsEnabled: true })).status,
    ).toBe(403);
    const refused = await h.call('POST', `/v1/content/${contentId}/comments`, viewer, {
      body: 'still?',
    });
    expect(refused.status).toBe(409);
    expect(code(refused.body)).toBe('comments_disabled');
    const list = (await h.call('GET', `/v1/content/${contentId}/comments`, viewer)).body as ListDto;
    expect(list.commentsEnabled).toBe(false);
    expect(list.items.length).toBeGreaterThan(0); // history stays readable
    await h.call('PATCH', `/v1/streams/${dept}`, owner, { commentsEnabled: true });
  });

  it('share-as-link delivers only to recipients who can already see the item and reveals nothing else', async () => {
    const toOutsider = await h.call('POST', `/v1/content/${contentId}/share`, viewer, {
      userId: outsider.userId,
    });
    expect(toOutsider.status).toBe(200);
    expect(toOutsider.body).toEqual({ delivered: false, linkPath: `/content/${contentId}` });
    const toViewer2 = await h.call('POST', `/v1/content/${contentId}/share`, viewer, {
      userId: viewer2.userId,
    });
    expect(toViewer2.body).toEqual({ delivered: true, linkPath: `/content/${contentId}` });
    expect(
      (await h.call('POST', `/v1/content/${contentId}/share`, viewer, { userId: viewer2.userId }))
        .body,
    ).toMatchObject({ delivered: true });
    const self = await h.call('POST', `/v1/content/${contentId}/share`, viewer, {
      userId: viewer.userId,
    });
    expect(self.status).toBe(400);
    expect(code(self.body)).toBe('self_share');
    const bySharerWithoutAccess = await h.call('POST', `/v1/content/${contentId}/share`, outsider, {
      userId: viewer.userId,
    });
    expect(bySharerWithoutAccess.status).toBe(404);
    expect(code(bySharerWithoutAccess.body)).toBe('content_not_found');
    // Unknown and no-access recipients are indistinguishable, and every attempt is audited.
    const unknown = await h.call('POST', `/v1/content/${contentId}/share`, viewer, {
      userId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(toOutsider.body);
    const audits = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event WHERE org_id = $1 AND action = 'content.shared' AND target->>'contentId' = $2`,
      [owner.orgId, contentId],
    );
    expect(audits.rows[0]!.n).toBe(4);
    const notes = (await h.call('GET', '/v1/notifications', viewer2)).body as {
      items: Array<{ kind: string; title: string | null }>;
    };
    expect(notes.items.filter((n) => n.kind === 'content.shared')).toHaveLength(1);
    expect(notes.items.find((n) => n.kind === 'content.shared')!.title).toBe('Budget talk');
    expect(
      ((await h.call('GET', '/v1/notifications', outsider)).body as { items: unknown[] }).items,
    ).toEqual([]);
  });

  it('retraction hides threads and refuses new comments, likes and shares', async () => {
    expect((await h.call('POST', `/v1/content/${contentId}/retract`, author)).status).toBe(200);
    for (const s of [viewer, moderator, author]) {
      expect((await h.call('GET', `/v1/content/${contentId}/comments`, s)).status).toBe(404);
      expect(
        (await h.call('POST', `/v1/content/${contentId}/comments`, s, { body: 'late' })).status,
      ).toBe(404);
    }
    expect((await h.call('POST', `/v1/content/${contentId}/like`, viewer)).status).toBe(404);
    expect(
      (await h.call('POST', `/v1/content/${contentId}/share`, viewer, { userId: viewer2.userId }))
        .status,
    ).toBe(404);
    // Rows are kept for audit but never served.
    const rows = await h.admin.query(
      `SELECT count(*)::int AS n FROM comment WHERE content_id = $1`,
      [contentId],
    );
    expect(rows.rows[0]!.n).toBeGreaterThan(0);
    expect(versionId).toBeTruthy();
  });
});
