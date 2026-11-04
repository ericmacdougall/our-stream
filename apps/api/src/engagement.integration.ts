// SPDX-License-Identifier: AGPL-3.0-only
// Engagement events (ADR-0006): idempotent per (session, content, version, type) under replay and
// concurrency; rewatch derived server-side; per-clip stats are author-only and never carry user ids
// unless the org privacy mode is `named`.
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

interface Stats {
  contentId: string;
  privacyMode: string;
  uniqueViewers: number;
  viewStarts: number;
  completions: number;
  rewatches: number;
  milestones: { p25: number; p50: number; p75: number };
  likes: number;
  comments: number;
  viewers?: Array<{
    userId: string;
    displayName: string;
    maxProgressPct: number;
    completed: boolean;
    watchCount: number;
  }>;
}

describe.skipIf(!integrationReady)('engagement, stats and privacy mode (integration)', () => {
  let h: Harness;
  let owner: Session;
  let author: Session;
  let viewer: Session;
  let viewer2: Session;
  let moderator: Session;
  let outsider: Session;
  let contentId: string;
  let versionId: string;
  let memberIds: string[];

  const event = (s: Session, body: Record<string, unknown>) =>
    h.call('POST', `/v1/content/${contentId}/engagement`, s, { versionId, ...body });

  beforeAll(async () => {
    h = await createHarness('engage');
    owner = await h.signup('owner', 'acme');
    author = await h.invite(owner, 'author', 'contributor');
    viewer = await h.invite(owner, 'viewer', 'member');
    viewer2 = await h.invite(owner, 'viewer2', 'member');
    moderator = await h.invite(owner, 'moderator', 'member');
    outsider = await h.invite(owner, 'outsider', 'member');
    const dept = await createStream(h, owner, 'dept', 'department', [
      { session: author, role: 'contributor' },
      { session: viewer, role: 'viewer' },
      { session: viewer2, role: 'viewer' },
      { session: moderator, role: 'moderator' },
    ]);
    ({ contentId, versionId } = await createPlayableContent(h, author, 'Measured'));
    const pub = await h.call('POST', `/v1/content/${contentId}/publish`, author, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    if (pub.status !== 200) throw new Error(`publish failed: ${pub.raw}`);
    memberIds = ((await h.call('GET', '/v1/members', owner)).body as Array<{ userId: string }>).map(
      (m) => m.userId,
    );
    expect(memberIds.length).toBe(6);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('events are idempotent per session+content+version+type, including under concurrency', async () => {
    const first = await event(viewer, { sessionKey: 's1', type: 'view_start' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ recorded: true });
    expect((await event(viewer, { sessionKey: 's1', type: 'view_start' })).body).toEqual({
      recorded: false,
    });
    const burst = await Promise.all(
      Array.from({ length: 10 }, () =>
        event(viewer, { sessionKey: 's1', type: 'progress_50', positionMs: 30_000 }),
      ),
    );
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect(burst.filter((r) => (r.body as { recorded: boolean }).recorded)).toHaveLength(1);
    expect(
      (await event(viewer, { sessionKey: 's1', type: 'progress_25', positionMs: 15_000 })).body,
    ).toEqual({ recorded: true });
    expect(
      (await event(viewer, { sessionKey: 's1', type: 'complete', positionMs: 60_000 })).body,
    ).toEqual({ recorded: true });
    const rows = await h.admin.query<{ type: string; n: number }>(
      `SELECT type, count(*)::int AS n FROM engagement_event WHERE content_id = $1 AND user_id = $2 GROUP BY type ORDER BY type`,
      [contentId, viewer.userId],
    );
    expect(rows.rows).toEqual([
      { type: 'complete', n: 1 },
      { type: 'progress_25', n: 1 },
      { type: 'progress_50', n: 1 },
      { type: 'view_start', n: 1 },
    ]);
    const stale = await event(viewer, {
      sessionKey: 's1',
      type: 'view_start',
      versionId: '00000000-0000-4000-8000-000000000000',
    });
    expect(stale.status).toBe(409);
    expect(code(stale.body)).toBe('stale_version');
    const invisible = await event(outsider, { sessionKey: 'o1', type: 'view_start' });
    expect(invisible.status).toBe(404);
    expect(code(invisible.body)).toBe('content_not_found');
    expect((await event(viewer, { sessionKey: 's1', type: 'progress_99' })).status).toBe(400);
    // Engagement alone keeps retraction targeting intact (ADR-0005 saw_version, review F1).
    const viewers = await h.admin.query<{ user_id: string; title_snapshot: string }>(
      'SELECT user_id, title_snapshot FROM platform_viewers_of_version($1, $2)',
      [owner.orgId, versionId],
    );
    expect(viewers.rows).toEqual([{ user_id: viewer.userId, title_snapshot: 'Measured' }]);
  });

  it('a new playback session after a completed one counts as a rewatch and bumps watch_count', async () => {
    expect((await event(viewer, { sessionKey: 's2', type: 'view_start' })).body).toEqual({
      recorded: true,
    });
    expect((await event(viewer, { sessionKey: 's2', type: 'view_start' })).body).toEqual({
      recorded: false,
    });
    expect((await event(viewer2, { sessionKey: 'v2-1', type: 'view_start' })).body).toEqual({
      recorded: true,
    });
    expect((await event(viewer2, { sessionKey: 'v2-1', type: 'progress_25' })).body).toEqual({
      recorded: true,
    });
    const state = await h.admin.query<{
      watch_count: number;
      max_progress_pct: number;
      completed: boolean;
    }>(
      `SELECT watch_count, max_progress_pct, completed_at IS NOT NULL AS completed FROM user_content_state WHERE content_id = $1 AND user_id = $2`,
      [contentId, viewer.userId],
    );
    expect(state.rows[0]).toEqual({ watch_count: 2, max_progress_pct: 100, completed: true });
    const rewatch = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM engagement_event WHERE content_id = $1 AND type = 'rewatch'`,
      [contentId],
    );
    expect(rewatch.rows[0]!.n).toBe(1);
  });

  it('stats are author-only and aggregate by default (identified_for_required_only): no user id anywhere in the body', async () => {
    expect((await h.call('POST', `/v1/content/${contentId}/like`, viewer)).status).toBe(200);
    for (const s of [viewer, outsider]) {
      const r = await h.call('GET', `/v1/content/${contentId}/stats`, s);
      expect(r.status).toBe(404);
      expect(code(r.body)).toBe('content_not_found');
    }
    for (const s of [author, moderator, owner]) {
      const r = await h.call('GET', `/v1/content/${contentId}/stats`, s);
      expect(r.status).toBe(200);
      const stats = r.body as Stats;
      expect(stats).toMatchObject({
        contentId,
        privacyMode: 'identified_for_required_only',
        uniqueViewers: 2,
        viewStarts: 3,
        completions: 1,
        rewatches: 1,
        milestones: { p25: 2, p50: 1, p75: 0 },
        likes: 1,
        comments: 0,
      });
      expect(stats.viewers).toBeUndefined();
      for (const id of memberIds) expect(r.raw, `user id ${id} leaked`).not.toContain(id);
    }
  });

  it('privacy mode named lists viewers; identified_for_required_only stays aggregate; only admins change it', async () => {
    const asMember = await h.call('GET', '/v1/org/settings', viewer);
    expect(asMember.status).toBe(200);
    expect(asMember.body).toMatchObject({
      privacyMode: 'identified_for_required_only',
      commentsEnabled: true,
      engagementRetentionDays: 395,
      commentScanPolicy: 'off',
    });
    const forbidden = await h.call('PATCH', '/v1/org/settings', viewer, { privacyMode: 'named' });
    expect(forbidden.status).toBe(403);
    expect(code(forbidden.body)).toBe('role_forbidden');
    expect(
      (await h.call('PATCH', '/v1/org/settings', owner, { privacyMode: 'bogus' })).status,
    ).toBe(400);
    const set = await h.call('PATCH', '/v1/org/settings', owner, { privacyMode: 'named' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ privacyMode: 'named' });
    const named = (await h.call('GET', `/v1/content/${contentId}/stats`, author)).body as Stats;
    expect(named.privacyMode).toBe('named');
    expect(named.viewers!.map((v) => v.userId).sort()).toEqual(
      [viewer.userId, viewer2.userId].sort(),
    );
    expect(named.viewers!.find((v) => v.userId === viewer.userId)).toMatchObject({
      displayName: expect.stringContaining('viewer') as string,
      maxProgressPct: 100,
      completed: true,
      watchCount: 2,
    });
    expect((await h.call('GET', `/v1/content/${contentId}/stats`, viewer)).status).toBe(404);
    await h.call('PATCH', '/v1/org/settings', owner, {
      privacyMode: 'identified_for_required_only',
    });
    const required = await h.call('GET', `/v1/content/${contentId}/stats`, author);
    expect((required.body as Stats).privacyMode).toBe('identified_for_required_only');
    expect((required.body as Stats).viewers).toBeUndefined();
    for (const id of [viewer.userId, viewer2.userId]) expect(required.raw).not.toContain(id);
    await h.call('PATCH', '/v1/org/settings', owner, { privacyMode: 'aggregate_only' });
    expect(
      ((await h.call('GET', `/v1/content/${contentId}/stats`, author)).body as Stats).viewers,
    ).toBeUndefined();
    // Settings merge: the M1a notify flag survives a privacy change.
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [owner.orgId]);
    await h.admin.query(
      `UPDATE org SET settings = settings || '{"notify":{"include_title_after_access_loss":"true"}}' WHERE id = $1`,
      [owner.orgId],
    );
    await h.call('PATCH', '/v1/org/settings', owner, { privacyMode: 'named' });
    const after = await h.admin.query<{ v: string }>(
      `SELECT settings->'notify'->>'include_title_after_access_loss' AS v FROM org WHERE id = $1`,
      [owner.orgId],
    );
    await h.admin.query(`SELECT set_config('app.org_id', '', false)`);
    expect(after.rows[0]!.v).toBe('true');
    await h.call('PATCH', '/v1/org/settings', owner, { privacyMode: 'aggregate_only' });
  });

  it('notification preferences default to a daily digest and are per member', async () => {
    expect((await h.call('GET', '/v1/me/preferences', viewer)).body).toEqual({
      emailDigest: 'daily',
    });
    expect(
      (await h.call('PATCH', '/v1/me/preferences', viewer, { emailDigest: 'off' })).body,
    ).toEqual({ emailDigest: 'off' });
    expect((await h.call('GET', '/v1/me/preferences', viewer)).body).toEqual({
      emailDigest: 'off',
    });
    expect((await h.call('GET', '/v1/me/preferences', viewer2)).body).toEqual({
      emailDigest: 'daily',
    });
    expect(
      (await h.call('PATCH', '/v1/me/preferences', viewer, { emailDigest: 'weekly' })).status,
    ).toBe(400);
  });
  it('caps distinct playback sessions per user, item and day', async () => {
    const r = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        event(moderator, { sessionKey: `flood-${i}`, type: 'view_start' }),
      ),
    );
    expect(r.every((x) => x.status === 200)).toBe(true);
    expect(r.filter((x) => (x.body as { recorded: boolean }).recorded).length).toBeLessThanOrEqual(
      50,
    );
    const rows = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM engagement_event WHERE content_id = $1 AND user_id = $2`,
      [contentId, moderator.userId],
    );
    expect(rows.rows[0]!.n).toBeLessThanOrEqual(50);
  });
});
