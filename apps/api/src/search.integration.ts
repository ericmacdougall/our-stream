// SPDX-License-Identifier: AGPL-3.0-only
// Keyword search (ADR-0013): results, counts and snippets agree with the readerVisible reference on
// every cell of the authz fixture; access lost mid-session disappears on the next request; filters
// never widen visibility; search terms never reach the logs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture, readerVisible, type FixtureOrg } from '@our-stream/authz';
import {
  createHarness,
  integrationReady,
  seedFixtureSessions,
  type Harness,
} from './test-harness.js';

interface Hit {
  id: string;
  title: string;
  tags: string[];
  score: number;
  media: { hls: string };
  snippets: Array<{ source: string; text: string; ranges: [number, number][]; tMs: number | null }>;
}
interface SearchBody {
  items: Hit[];
  total: number;
  nextCursor: string | null;
}

describe.skipIf(!integrationReady)('search (integration)', () => {
  let h: Harness;
  let fixture: ReturnType<typeof buildFixture>;
  let cookies: Map<string, string>;
  const now = new Date();

  const search = async (org: FixtureOrg, userId: string, qs: string) => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/search?${qs}`,
      cookies: { os_session: cookies.get(`${org.orgId}:${userId}`)! },
    });
    return {
      status: res.statusCode,
      body: res.statusCode === 200 ? (res.json() as SearchBody) : null,
    };
  };
  const expectedIds = (org: FixtureOrg, userId: string) =>
    new Set(org.content.filter((c) => readerVisible(org, userId, c.id, now)).map((c) => c.id));

  beforeAll(async () => {
    h = await createHarness('search', { LOG_LEVEL: 'info' });
    fixture = buildFixture(`-search-${h.suffix}`);
    cookies = await seedFixtureSessions(h, fixture, { transcript: true });
  });
  afterAll(async () => {
    await h.admin.query(`DELETE FROM org WHERE slug IN ($1, $2)`, [
      fixture.orgs[0].slug,
      fixture.orgs[1].slug,
    ]);
    await h.cleanup();
  });

  it('results, total and snippets agree with the readerVisible reference on every (org, user) cell', async () => {
    let cells = 0;
    for (const org of fixture.orgs) {
      for (const [name, userId] of Object.entries(fixture.users)) {
        const expected = expectedIds(org, userId);
        for (const q of ['title', 'budget']) {
          const r = await search(org, userId, `q=${q}&limit=50`);
          if (r.status !== 200) {
            expect([401, 403], `org=${org.slug} user=${name}`).toContain(r.status);
            expect(expected.size).toBe(0);
            continue;
          }
          const got = new Set(r.body!.items.map((i) => i.id));
          for (const c of org.content) {
            cells += 1;
            expect(got.has(c.id), `q=${q} org=${org.slug} user=${name} content=${c.id}`).toBe(
              expected.has(c.id),
            );
          }
          expect(r.body!.total, `total q=${q} user=${name}`).toBe(expected.size);
          const other = fixture.orgs.find((o) => o !== org)!;
          for (const c of other.content) expect(got.has(c.id)).toBe(false);
          for (const hit of r.body!.items) {
            expect(hit.snippets.length).toBeGreaterThan(0);
            for (const s of hit.snippets) {
              expect(s.text).not.toMatch(/[<>\uE000\uE001]/);
              for (const [a, b] of s.ranges) {
                expect(b).toBeGreaterThan(a);
                expect(s.text.slice(a, b).toLowerCase()).toBe(q);
              }
              if (s.source === 'transcript') expect(s.tMs).toBe(40_000);
              else expect(s.tMs).toBeNull();
            }
            if (q === 'budget')
              expect(hit.snippets.some((s) => s.source === 'transcript')).toBe(true);
          }
        }
      }
    }
    expect(cells).toBeGreaterThan(400);
  });

  it('access lost mid-session is gone on the next search (no job, no re-login)', async () => {
    const org = fixture.orgs[0];
    const user = fixture.users.member2!; // reaches the department stream through platform ⊂ backend ⊂ engineering
    const before = await search(org, user, 'q=budget&limit=50');
    expect(before.body!.items.map((i) => i.id)).toContain(org.contentNames.deptPublished);
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
    await h.admin.query(
      `DELETE FROM relation_tuple WHERE org_id = $1 AND object_type = 'group' AND object_id = $2 AND subject_type = 'user' AND subject_id = $3`,
      [org.orgId, org.groupNames.platform, user],
    );
    await h.admin.query(`SELECT set_config('app.org_id', '', false)`);
    const snapshot: FixtureOrg = {
      ...org,
      tuples: org.tuples.filter(
        (t) =>
          !(
            t.objectType === 'group' &&
            t.objectId === org.groupNames.platform &&
            t.subjectType === 'user' &&
            t.subjectId === user
          ),
      ),
    };
    const expected = new Set(
      snapshot.content.filter((c) => readerVisible(snapshot, user, c.id, now)).map((c) => c.id),
    );
    const after = await search(org, user, 'q=budget&limit=50');
    expect(new Set(after.body!.items.map((i) => i.id))).toEqual(expected);
    expect(after.body!.total).toBe(expected.size);
    expect(expected.has(org.contentNames.deptPublished)).toBe(false);
  });

  it('stream and tag filters only narrow: an invisible tagged item stays invisible and uncounted', async () => {
    const org = fixture.orgs[1];
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
    await h.admin.query(
      `UPDATE content SET event_tags = '{training}' WHERE org_id = $1 AND id = ANY($2::uuid[])`,
      [org.orgId, [org.contentNames.privatePublished, org.contentNames.companyPublished]],
    );
    await h.admin.query(`SELECT set_config('app.org_id', '', false)`);
    const member = fixture.users.member!; // no access to the private stream
    const tagged = await search(org, member, 'q=budget&tag=training&limit=50');
    expect(tagged.body!.items.map((i) => i.id)).toEqual([org.contentNames.companyPublished]);
    expect(tagged.body!.total).toBe(1);
    const privateStream = await search(
      org,
      member,
      `q=budget&streamId=${org.streamNames.private}&limit=50`,
    );
    expect(privateStream.body!.items).toEqual([]);
    expect(privateStream.body!.total).toBe(0);
    const admin = fixture.users.admin!; // owns the private stream
    const asAdmin = await search(
      org,
      admin,
      `q=budget&streamId=${org.streamNames.private}&limit=50`,
    );
    expect(asAdmin.body!.items.map((i) => i.id)).toEqual([org.contentNames.privatePublished]);
  });

  it('pages with a stable cursor and caps the page size', async () => {
    const org = fixture.orgs[0];
    const user = fixture.users.admin!;
    const all = await search(org, user, 'q=title&limit=50');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await search(
        org,
        user,
        `q=title&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(r.status).toBe(200);
      expect(r.body!.items.length).toBeLessThanOrEqual(2);
      expect(r.body!.total).toBe(all.body!.total);
      seen.push(...r.body!.items.map((i) => i.id));
      cursor = r.body!.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);
    expect(seen.sort()).toEqual(all.body!.items.map((i) => i.id).sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect((await search(org, user, 'q=title&limit=51')).status).toBe(400);
    expect((await search(org, user, 'q=title&cursor=not-a-cursor')).status).toBe(400);
  });

  it('operator-only queries answer an empty page, not an error', async () => {
    const org = fixture.orgs[0];
    const r = await search(org, fixture.users.admin!, 'q=-&limit=10');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ items: [], total: 0, nextCursor: null });
    expect(
      (await search(org, fixture.users.admin!, 'q=%22quarterly%20budget%22')).body!.total,
    ).toBeGreaterThan(0);
  });

  it('sentinel characters in stored text cannot corrupt highlight ranges', async () => {
    const org = fixture.orgs[0];
    const target = org.contentNames.orgPublished;
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
    await h.admin.query(`UPDATE content SET title = $3 WHERE org_id = $1 AND id = $2`, [
      org.orgId,
      target,
      'title \uE000plan\uE001 \uE000 roadmap plan',
    ]);
    await h.admin.query(`SELECT set_config('app.org_id', '', false)`);
    const r = await search(org, fixture.users.member!, 'q=roadmap&limit=10');
    const hit = r.body!.items.find((i) => i.id === target)!;
    expect(hit).toBeDefined();
    const snippet = hit.snippets.find((s) => s.source === 'title')!;
    expect(snippet.text).not.toMatch(/[\uE000\uE001]/);
    for (const [a, b] of snippet.ranges)
      expect(snippet.text.slice(a, b).toLowerCase()).toBe('roadmap');
    expect(hit.media.hls).toMatch(/^\/media\//);
  });

  it('never logs the search term', async () => {
    const org = fixture.orgs[0];
    const canary = `canaryzebra${Date.now()}`;
    const r = await search(org, fixture.users.admin!, `q=${canary}%20budget&limit=5`);
    expect(r.status).toBe(200);
    const joined = h.logs.join('\n');
    expect(joined).toContain('/v1/search'); // request logging is on for this suite
    expect(joined).not.toContain(canary);
  });

  it('a retracted item leaves search on the next request', async () => {
    const org = fixture.orgs[1];
    const user = fixture.users.member!;
    const target = org.contentNames.companyPublished;
    expect((await search(org, user, 'q=budget&limit=50')).body!.items.map((i) => i.id)).toContain(
      target,
    );
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
    await h.admin.query(
      `UPDATE content SET state = 'retracted', retracted_at = now() WHERE org_id = $1 AND id = $2`,
      [org.orgId, target],
    );
    await h.admin.query(`SELECT set_config('app.org_id', '', false)`);
    expect(
      (await search(org, user, 'q=budget&limit=50')).body!.items.map((i) => i.id),
    ).not.toContain(target);
  });
});
