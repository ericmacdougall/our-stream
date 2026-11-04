// SPDX-License-Identifier: AGPL-3.0-only
// Publish rules through the API, feed agreement with the authz reference over the fixture matrix,
// scheduling, retraction, upload round trip and view recording.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture, readerVisible, type FixtureOrg } from '@our-stream/authz';
import { sha256 } from './lib/tokens.js';
import {
  createHarness,
  createPlayableContent,
  createStream,
  integrationReady,
  type Harness,
  type Session,
} from './test-harness.js';

const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;
const feedIds = async (h: Harness, s: Session, extra = '') => {
  const r = await h.call('GET', `/v1/feed?limit=50${extra}`, s);
  if (r.status !== 200) return { status: r.status, ids: new Set<string>() };
  return {
    status: 200,
    ids: new Set((r.body as { items: Array<{ id: string }> }).items.map((i) => i.id)),
  };
};

describe.skipIf(!integrationReady)('content, publish rules and feed (integration)', () => {
  let h: Harness;
  let owner: Session;
  let announcer: Session;
  let contributor: Session;
  let member: Session;
  let outsider: Session; // active member of the org with no stream beyond company
  let dept: string;

  beforeAll(async () => {
    h = await createHarness('content');
    owner = await h.signup('owner', 'acme');
    announcer = await h.invite(owner, 'announcer', 'announcer');
    contributor = await h.invite(owner, 'contributor', 'contributor');
    member = await h.invite(owner, 'member', 'member');
    outsider = await h.invite(owner, 'outsider', 'member');
    dept = await createStream(h, owner, 'dept', 'department', [
      { session: contributor, role: 'contributor' },
      { session: member, role: 'viewer' },
    ]);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('members cannot create content; contributors create drafts owned by themselves', async () => {
    const denied = await h.call('POST', '/v1/content', member, { kind: 'clip', title: 'nope' });
    expect(denied.status).toBe(403);
    expect(errorCode(denied.body)).toBe('role_forbidden');
    const ok = await h.call('POST', '/v1/content', contributor, {
      kind: 'clip',
      title: 'Draft',
      chapters: [{ atMs: 1000, title: 'Intro' }],
      links: [{ kind: 'internet', url: 'https://example.com/', label: 'Example' }],
    });
    expect(ok.status).toBe(200);
    const detail = ok.body as {
      state: string;
      owner: { id: string };
      chapters: unknown[];
      canEdit: boolean;
    };
    expect(detail.state).toBe('draft');
    expect(detail.owner.id).toBe(contributor.userId);
    expect(detail.chapters).toEqual([{ atMs: 1000, title: 'Intro' }]);
    expect(detail.canEdit).toBe(true);
  });

  it('publish rules: no media, member to a stream, contributor to a viewer-only stream, org-wide needs announcer', async () => {
    const draft = await h.call('POST', '/v1/content', contributor, {
      kind: 'clip',
      title: 'Rules',
    });
    const id = (draft.body as { id: string }).id;
    const noMedia = await h.call('POST', `/v1/content/${id}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    expect(noMedia.status).toBe(409);
    expect(errorCode(noMedia.body)).toBe('no_media');

    const { contentId } = await createPlayableContent(h, contributor, 'Rules 2');
    // A member is not the author: 404 (no existence oracle) rather than a rule error.
    const byMember = await h.call('POST', `/v1/content/${contentId}/publish`, member, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    expect(byMember.status).toBe(404);

    // Contributor on dept, but only a viewer on the company stream.
    const streams = (await h.call('GET', '/v1/streams', contributor)).body as Array<{
      id: string;
      kind: string;
      myRole: string | null;
    }>;
    const company = streams.find((s) => s.kind === 'company')!;
    expect(company.myRole).toBe('viewer');
    const toCompany = await h.call('POST', `/v1/content/${contentId}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: company.id }],
    });
    expect(toCompany.status).toBe(403);
    expect(errorCode(toCompany.body)).toBe('stream_forbidden');

    const orgWide = await h.call('POST', `/v1/content/${contentId}/publish`, contributor, {
      audience: [{ type: 'everyone' }],
    });
    expect(orgWide.status).toBe(403);
    expect(errorCode(orgWide.body)).toBe('org_wide_forbidden');

    // Nothing above leaked into the feed: the item is still a draft.
    expect((await feedIds(h, member)).ids.has(contentId)).toBe(false);
    expect((await feedIds(h, contributor)).ids.has(contentId)).toBe(false);

    // The announcer may publish their own content org-wide.
    const ann = await createPlayableContent(h, announcer, 'Org wide');
    const annPub = await h.call('POST', `/v1/content/${ann.contentId}/publish`, announcer, {
      audience: [{ type: 'everyone' }],
    });
    expect(annPub.status).toBe(200);
    expect((await feedIds(h, outsider)).ids.has(ann.contentId)).toBe(true);
  });

  it('a draft with a playable version is never in the feed, not even for its owner; publishing to dept shows it to dept viewers only', async () => {
    const { contentId, versionId } = await createPlayableContent(h, contributor, 'Dept clip');
    expect((await feedIds(h, contributor)).ids.has(contentId)).toBe(false);
    expect((await feedIds(h, owner)).ids.has(contentId)).toBe(false);

    const pub = await h.call('POST', `/v1/content/${contentId}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    expect(pub.status).toBe(200);
    const detail = pub.body as { state: string; audience: unknown[]; publishAt: string | null };
    expect(detail.state).toBe('published');
    expect(detail.audience).toEqual([{ type: 'stream', streamId: dept }]);
    expect(detail.publishAt).not.toBeNull();

    expect((await feedIds(h, member)).ids.has(contentId)).toBe(true);
    expect((await feedIds(h, contributor)).ids.has(contentId)).toBe(true);
    expect((await feedIds(h, outsider)).ids.has(contentId)).toBe(false);
    expect((await feedIds(h, owner)).ids.has(contentId)).toBe(true); // created the stream, so holds owner on it
    expect((await feedIds(h, announcer)).ids.has(contentId)).toBe(false); // org role grants no stream access

    const feed = (await h.call('GET', '/v1/feed', member)).body as {
      items: Array<{
        id: string;
        versionId: string;
        media: { hls: string; poster: string | null; captions: Array<{ url: string }> };
        streams: Array<{ id: string }>;
        viewed: boolean;
      }>;
      authzEpoch: number;
      orgContentEpoch: number;
    };
    const item = feed.items.find((i) => i.id === contentId)!;
    expect(item.versionId).toBe(versionId);
    expect(item.media.hls).toBe(`/media/${contentId}/${versionId}/hls/master.m3u8`);
    expect(item.media.poster).toBe(`/media/${contentId}/${versionId}/poster.jpg`);
    expect(item.media.captions).toEqual([
      { lang: 'en', url: `/media/${contentId}/${versionId}/captions/en.vtt` },
    ]);
    expect(item.streams.map((s) => s.id)).toEqual([dept]);
    expect(item.viewed).toBe(false);
    expect(feed.authzEpoch).toBeGreaterThan(0);
    expect(feed.orgContentEpoch).toBeGreaterThan(0);

    // Stream filter: dept viewers can filter by dept; a filter on a stream the user cannot access is empty.
    expect((await feedIds(h, member, `&streamId=${dept}`)).ids.has(contentId)).toBe(true);
    expect((await feedIds(h, outsider, `&streamId=${dept}`)).ids.size).toBe(0);

    // Views: current version recorded, stale version refused, viewed flag flips.
    const view = await h.call('POST', `/v1/content/${contentId}/view`, member, {
      versionId,
      completed: true,
    });
    expect(view.status).toBe(200);
    const stale = await h.call('POST', `/v1/content/${contentId}/view`, member, {
      versionId: randomUUID(),
    });
    expect(stale.status).toBe(409);
    const nonViewer = await h.call('POST', `/v1/content/${contentId}/view`, outsider, {
      versionId,
    });
    expect(nonViewer.status).toBe(404);
    const after = (await h.call('GET', '/v1/feed', member)).body as {
      items: Array<{ id: string; viewed: boolean }>;
    };
    expect(after.items.find((i) => i.id === contentId)!.viewed).toBe(true);

    // Detail: viewer sees it without the audience; outsider gets 404; owner edits bump the epoch.
    const asViewer = (await h.call('GET', `/v1/content/${contentId}`, member)).body as {
      canEdit: boolean;
      audience: unknown[];
      contentEpoch: number;
    };
    expect(asViewer.canEdit).toBe(false);
    expect(asViewer.audience).toEqual([]);
    expect((await h.call('GET', `/v1/content/${contentId}`, outsider)).status).toBe(404);
    expect(
      (await h.call('PATCH', `/v1/content/${contentId}`, member, { title: 'hax' })).status,
    ).toBe(404);
    const edited = (
      await h.call('PATCH', `/v1/content/${contentId}`, contributor, {
        links: [{ kind: 'intranet', url: 'https://intranet.example/x', label: 'Policy' }],
      })
    ).body as { contentEpoch: number; links: unknown[] };
    expect(edited.links).toHaveLength(1);
    expect(edited.contentEpoch).toBeGreaterThan(asViewer.contentEpoch);
  });

  it('scheduled items are absent before publish_at and appear once it passes; events are emitted', async () => {
    const { contentId, versionId } = await createPlayableContent(h, contributor, 'Scheduled');
    const publishAt = new Date(Date.now() + 3_600_000).toISOString();
    const expiresAt = new Date(Date.now() + 7_200_000).toISOString();
    const pub = await h.call('POST', `/v1/content/${contentId}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
      publishAt,
      expiresAt,
    });
    expect(pub.status).toBe(200);
    expect((pub.body as { state: string }).state).toBe('published');
    expect((await feedIds(h, member)).ids.has(contentId)).toBe(false);

    const events = await h.admin.query<{
      type: string;
      version_id: string | null;
      payload: { publishAt?: string };
    }>(
      `SELECT type, version_id, payload FROM platform.domain_event WHERE subject_id = $1 ORDER BY id`,
      [contentId],
    );
    const types = events.rows.map((e) => e.type);
    expect(types).toContain('content.scheduled');
    expect(types).toContain('content.expiry_scheduled');
    expect(types).not.toContain('content.published');
    expect(events.rows.find((e) => e.type === 'content.scheduled')!.payload.publishAt).toBe(
      publishAt,
    );
    expect(events.rows.find((e) => e.type === 'content.scheduled')!.version_id).toBe(versionId);

    // Time passes (the transition job only bumps epochs; visibility is SQL-only, ADR-0003).
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [owner.orgId]);
    await h.admin.query(
      `UPDATE content SET publish_at = now() - interval '1 second' WHERE org_id = $1 AND id = $2`,
      [owner.orgId, contentId],
    );
    expect((await feedIds(h, member)).ids.has(contentId)).toBe(true);

    // Bad expiry is refused.
    const bad = await h.call('POST', `/v1/content/${contentId}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
      publishAt,
      expiresAt: publishAt,
    });
    expect(bad.status).toBe(400);
  });

  it('retraction removes the item from the feed on the next request and emits content.retracted with the version', async () => {
    const { contentId, versionId } = await createPlayableContent(h, contributor, 'To retract');
    await h.call('POST', `/v1/content/${contentId}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    expect((await feedIds(h, member)).ids.has(contentId)).toBe(true);
    const byMember = await h.call('POST', `/v1/content/${contentId}/retract`, member);
    expect(byMember.status).toBe(404);
    const r = await h.call('POST', `/v1/content/${contentId}/retract`, contributor);
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe('retracted');
    expect((await feedIds(h, member)).ids.has(contentId)).toBe(false);
    const ev = await h.admin.query<{ version_id: string }>(
      `SELECT version_id FROM platform.domain_event WHERE subject_id = $1 AND type = 'content.retracted'`,
      [contentId],
    );
    expect(ev.rows.map((e) => e.version_id)).toEqual([versionId]);
    const again = await h.call('POST', `/v1/content/${contentId}/retract`, contributor);
    expect(again.status).toBe(409);
    const republish = await h.call('POST', `/v1/content/${contentId}/publish`, contributor, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    expect(republish.status).toBe(409);
  });

  it('upload: a part count that does not fit the file size is refused before any version row or multipart upload exists (N5)', async () => {
    const c = await h.call('POST', '/v1/content', contributor, { kind: 'clip', title: 'Parts cap' });
    const contentId = (c.body as { id: string }).id;
    const init = await h.call('POST', `/v1/content/${contentId}/upload/init`, contributor, {
      fileName: 'small.mp4',
      mimeType: 'video/mp4',
      size: 1024,
      parts: 40,
    });
    expect(init.status).toBe(400);
    expect((init.body as { error: { code: string } }).error.code).toBe('too_many_parts');
    const rows = await h.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM content_version WHERE content_id = $1',
      [contentId],
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('upload: init issues presigned part URLs under the server-built key; complete verifies size and emits version_uploaded', async () => {
    const c = await h.call('POST', '/v1/content', contributor, { kind: 'clip', title: 'Upload' });
    const contentId = (c.body as { id: string }).id;
    const payload = Buffer.from('tiny fake video bytes');
    const init = await h.call('POST', `/v1/content/${contentId}/upload/init`, contributor, {
      fileName: '../../evil name.mp4',
      mimeType: 'video/mp4',
      size: payload.length,
      parts: 1,
    });
    expect(init.status).toBe(200);
    const body = init.body as {
      versionId: string;
      uploadId: string;
      key: string;
      partUrls: Array<{ partNumber: number; url: string }>;
    };
    expect(
      body.key.startsWith(
        `orgs/${owner.orgId}/content/${contentId}/versions/${body.versionId}/original/`,
      ),
    ).toBe(true);
    expect(body.key).not.toContain('evil');
    expect(body.partUrls).toHaveLength(1);

    const put = await fetch(body.partUrls[0]!.url, { method: 'PUT', body: payload });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag')!;
    expect(etag).toBeTruthy();

    const byMember = await h.call('POST', `/v1/content/${contentId}/upload/complete`, member, {
      versionId: body.versionId,
      uploadId: body.uploadId,
      parts: [{ partNumber: 1, etag }],
    });
    expect(byMember.status).toBe(404);

    const done = await h.call('POST', `/v1/content/${contentId}/upload/complete`, contributor, {
      versionId: body.versionId,
      uploadId: body.uploadId,
      parts: [{ partNumber: 1, etag }],
    });
    expect(done.status).toBe(200);
    const again = await h.call('POST', `/v1/content/${contentId}/upload/complete`, contributor, {
      versionId: body.versionId,
      uploadId: body.uploadId,
      parts: [{ partNumber: 1, etag }],
    });
    expect(again.status).toBe(409);
    const ev = await h.admin.query(
      `SELECT 1 FROM platform.domain_event WHERE subject_id = $1 AND version_id = $2 AND type = 'content.version_uploaded'`,
      [contentId, body.versionId],
    );
    expect(ev.rowCount).toBe(1);
    const stored = await h.store.head(body.key);
    expect(stored?.size).toBe(payload.length);

    // Size mismatch is refused.
    const init2 = await h.call('POST', `/v1/content/${contentId}/replace`, contributor, {
      fileName: 'v2.mp4',
      mimeType: 'video/mp4',
      size: payload.length + 100,
      parts: 1,
    });
    const b2 = init2.body as typeof body;
    const put2 = await fetch(b2.partUrls[0]!.url, { method: 'PUT', body: payload });
    const bad = await h.call('POST', `/v1/content/${contentId}/upload/complete`, contributor, {
      versionId: b2.versionId,
      uploadId: b2.uploadId,
      parts: [{ partNumber: 1, etag: put2.headers.get('etag') }],
    });
    expect(bad.status).toBe(400);
    expect(errorCode(bad.body)).toBe('size_mismatch');
    // The detail shows the in-flight version to the author.
    const detail = (await h.call('GET', `/v1/content/${contentId}`, contributor)).body as {
      currentVersion: { id: string; status: string; processingStep: string } | null;
    };
    expect(detail.currentVersion?.status).toBe('uploaded');
  });

  it('feed agrees with the readerVisible reference on every (org, user) cell of the authz fixture', async () => {
    const fixture = buildFixture(`-feed-${h.suffix}`);
    const now = new Date();
    const cookies = new Map<string, string>();
    await h.admin.query('BEGIN');
    for (const [name, id] of Object.entries(fixture.users)) {
      await h.admin.query(
        'INSERT INTO platform.user_account (id, email, email_normalized, display_name) VALUES ($1, $2, $2, $3)',
        [id, `api-${h.suffix}-fx-${name}-${id.slice(0, 8)}@example.invalid`, name],
      );
    }
    for (const org of fixture.orgs) await seedFixtureOrg(h, org);
    await h.admin.query('COMMIT');
    try {
      let cells = 0;
      for (const org of fixture.orgs) {
        for (const [name, userId] of Object.entries(fixture.users)) {
          const token = `fx-${org.slug}-${name}-${randomUUID()}`;
          await h.admin.query(`SELECT platform_session_create($1, $2, $3, interval '1 hour')`, [
            userId,
            org.orgId,
            sha256(token),
          ]);
          cookies.set(`${org.orgId}:${userId}`, token);
          const res = await h.app.inject({
            method: 'GET',
            url: '/v1/feed?limit=50',
            cookies: { os_session: token },
          });
          const got =
            res.statusCode === 200
              ? new Set((res.json() as { items: Array<{ id: string }> }).items.map((i) => i.id))
              : new Set<string>();
          if (res.statusCode !== 200) expect([401, 403]).toContain(res.statusCode);
          for (const c of org.content) {
            cells += 1;
            expect(got.has(c.id), `org=${org.slug} user=${name} content=${c.id}`).toBe(
              readerVisible(org, userId, c.id, now),
            );
          }
          const other = fixture.orgs.find((o) => o !== org)!;
          for (const c of other.content) expect(got.has(c.id)).toBe(false);
        }
      }
      expect(cells).toBeGreaterThan(200);
    } finally {
      await h.admin.query(`DELETE FROM org WHERE slug IN ($1, $2)`, [
        fixture.orgs[0].slug,
        fixture.orgs[1].slug,
      ]);
    }
  });
});

/** Seeds one fixture org like packages/authz matrix.integration.ts, with playable current versions. */
async function seedFixtureOrg(h: Harness, org: FixtureOrg): Promise<void> {
  const admin = h.admin;
  await admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
  await admin.query('INSERT INTO org (id, slug, name) VALUES ($1, $2, $2)', [org.orgId, org.slug]);
  for (const m of org.memberships)
    await admin.query(
      'INSERT INTO org_membership (org_id, user_id, role, status) VALUES ($1, $2, $3, $4)',
      [org.orgId, m.userId, m.role, m.status],
    );
  for (const g of org.groups)
    await admin.query(
      'INSERT INTO "group" (org_id, id, name, is_private) VALUES ($1, $2, $3, $4)',
      [org.orgId, g.id, g.id, g.isPrivate],
    );
  for (const [name, id] of Object.entries(org.streamNames)) {
    await admin.query(
      'INSERT INTO stream (org_id, id, kind, slug, name) VALUES ($1, $2, $3, $4, $4)',
      [
        org.orgId,
        id,
        name === 'company' ? 'company' : name === 'department' ? 'department' : 'private',
        name,
      ],
    );
  }
  for (const c of org.content) {
    await admin.query(
      `INSERT INTO content (org_id, id, kind, owner_id, title, state, publish_at, expires_at, retracted_at, review_requested)
       VALUES ($1, $2, 'clip', $3, $4, $5, $6, $7, $8, $9)`,
      [
        org.orgId,
        c.id,
        c.ownerId,
        `title ${c.id.slice(0, 8)}`,
        c.state,
        c.publishAt,
        c.expiresAt,
        c.retractedAt,
        c.reviewRequested,
      ],
    );
    const v = await admin.query<{ id: string }>(
      `INSERT INTO content_version (org_id, content_id, status, assets) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [
        org.orgId,
        c.id,
        c.state === 'retracted' ? 'retracted' : 'current',
        JSON.stringify({ hls: { master: 'hls/master.m3u8' } }),
      ],
    );
    await admin.query('UPDATE content SET current_version_id = $3 WHERE org_id = $1 AND id = $2', [
      org.orgId,
      c.id,
      v.rows[0]!.id,
    ]);
  }
  for (const t of org.tuples) {
    await admin.query(
      `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        org.orgId,
        t.objectType,
        t.objectId,
        t.relation,
        t.subjectType,
        t.subjectId,
        t.subjectRelation,
      ],
    );
  }
  await admin.query(`SELECT set_config('app.org_id', '', false)`);
}
