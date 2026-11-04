// SPDX-License-Identifier: AGPL-3.0-only
// Notifications render permission-checked (ADR-0005): the live title only while the recipient still
// passes readerVisible, otherwise the view-time snapshot (org opt-in) or nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  createPlayableContent,
  createStream,
  integrationReady,
  type Harness,
  type Session,
} from './test-harness.js';

describe.skipIf(!integrationReady)('notifications (integration)', () => {
  let h: Harness;
  let owner: Session;
  let author: Session;
  let viewer: Session;
  let other: Session;
  let dept: string;
  let contentId: string;
  let versionId: string;

  beforeAll(async () => {
    h = await createHarness('notif');
    owner = await h.signup('owner', 'acme');
    author = await h.invite(owner, 'author', 'contributor');
    viewer = await h.invite(owner, 'viewer', 'member');
    other = await h.invite(owner, 'other', 'member');
    dept = await createStream(h, owner, 'dept', 'department', [
      { session: author, role: 'contributor' },
      { session: viewer, role: 'viewer' },
    ]);
    ({ contentId, versionId } = await createPlayableContent(h, author, 'Live title'));
    await h.call('POST', `/v1/content/${contentId}/publish`, author, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [owner.orgId]);
    await h.admin.query(
      `INSERT INTO notification (org_id, user_id, kind, reason, content_id, version_id, title_snapshot, dedupe_key)
       VALUES ($1, $2, 'content.retracted', 'saw_version', $3, $4, 'Title as seen', 'k1'),
              ($1, $2, 'content.retracted', 'saw_version', $3, $4, NULL, 'k2')`,
      [owner.orgId, viewer.userId, contentId, versionId],
    );
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('shows the live title while the recipient can view the content', async () => {
    const r = await h.call('GET', '/v1/notifications', viewer);
    expect(r.status).toBe(200);
    const body = r.body as {
      items: Array<{ title: string | null; contentId: string }>;
      unread: number;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items.every((n) => n.title === 'Live title')).toBe(true);
    expect(body.unread).toBe(2);
    // Another member sees nothing of it.
    expect(
      ((await h.call('GET', '/v1/notifications', other)).body as { items: unknown[] }).items,
    ).toEqual([]);
  });

  it('falls back to the snapshot, or nothing, once the recipient loses access', async () => {
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [owner.orgId]);
    await h.admin.query(
      `DELETE FROM relation_tuple WHERE org_id = $1 AND object_type = 'stream' AND object_id = $2 AND subject_type = 'user' AND subject_id = $3`,
      [owner.orgId, dept, viewer.userId],
    );
    const r = await h.call('GET', '/v1/notifications', viewer);
    const body = r.body as { items: Array<{ title: string | null }> };
    expect(body.items.map((n) => n.title).sort()).toEqual([null, 'Title as seen'].sort());
    expect(r.raw).not.toContain('Live title');
  });

  it('marks notifications read for the owner only', async () => {
    const list = (await h.call('GET', '/v1/notifications', viewer)).body as {
      items: Array<{ id: string }>;
    };
    const id = list.items[0]!.id;
    expect((await h.call('POST', `/v1/notifications/${id}/read`, other)).status).toBe(404);
    expect((await h.call('POST', `/v1/notifications/${id}/read`, viewer)).status).toBe(200);
    const after = (await h.call('GET', '/v1/notifications', viewer)).body as {
      items: Array<{ id: string; readAt: string | null }>;
      unread: number;
    };
    expect(after.unread).toBe(1);
    expect(after.items.find((n) => n.id === id)!.readAt).not.toBeNull();
  });
});
