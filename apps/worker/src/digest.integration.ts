// SPDX-License-Identifier: AGPL-3.0-only
// Daily digest against Postgres (admin seeds, platform role runs): one email per member per day,
// titles only while the member passes readerVisible, read notifications and opted-out, deactivated
// members excluded, failed sends retried on the next run without duplicates, and the comment fan-out.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runMigrations } from '@our-stream/db';
import { FakeMailer } from '@our-stream/notifications';
import { runDigest } from './digest.js';
import type { JobContext } from './jobs.js';
import { runEngagementRetention, runSearchPrune } from './maintenance.js';
import { dispatchEvent } from './outbox.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const platformUrl = process.env['DATABASE_PLATFORM_URL'];
const enabled = Boolean(adminUrl && platformUrl);

describe.skipIf(!enabled)('digest, comment fan-out and maintenance (integration)', () => {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const platform = new pg.Pool({ connectionString: platformUrl, max: 2 });
  const mailer = new FakeMailer();
  const errors: string[] = [];
  let ctx: JobContext;
  const tag = randomBytes(4).toString('hex');
  const email = (name: string) => `${name}-${tag}@example.test`;
  const ids = {
    org: '',
    owner: '',
    daily: '',
    off: '',
    gone: '',
    lost: '',
    flaky: '',
    orgClip: '',
    deptClip: '',
    dept: '',
  };
  const day = new Date().toISOString().slice(0, 10);

  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await admin.query<T>(sql, params)).rows;
  // Other suites share the database and runDigest covers every org, so assertions stay scoped to this
  // suite's addresses and org rows rather than the run-wide counters.
  const mine = () => mailer.sent.filter((m) => m.to.endsWith(`-${tag}@example.test`));
  const notify = (user: string, kind: string, content: string, dedupe: string) =>
    q(`SELECT platform_notify($1, $2, $3, 'audience', $4, NULL, NULL, $5, '{}'::jsonb)`, [
      ids.org,
      user,
      kind,
      content,
      dedupe,
    ]);

  beforeAll(async () => {
    await runMigrations(adminUrl!);
    ctx = {
      tenantPool: platform,
      platformPool: platform,
      queue: { send: async () => 'id' },
      store: {} as JobContext['store'],
      asr: {} as JobContext['asr'],
      limits: {} as JobContext['limits'],
      mailer,
      appBaseUrl: 'https://os.example',
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (o, m) => errors.push(`${m ?? ''} ${JSON.stringify(o)}`),
      },
      now: () => new Date(),
    };
    const mkUser = async (name: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO platform.user_account (email, email_normalized, display_name) VALUES ($1, $1, $2) RETURNING id`,
          [email(name), name],
        )
      )[0]!.id;
    ids.owner = await mkUser('owner');
    ids.daily = await mkUser('daily');
    ids.off = await mkUser('off');
    ids.gone = await mkUser('gone');
    ids.lost = await mkUser('lost');
    ids.flaky = await mkUser('flaky');
    ids.org = (
      await q<{ id: string }>(`SELECT platform_org_create($1, $2, $3) AS id`, [
        ids.owner,
        `dg-${tag}`,
        'Digest IT',
      ])
    )[0]!.id;
    for (const u of [ids.daily, ids.off, ids.gone, ids.lost, ids.flaky])
      await q(
        `INSERT INTO org_membership (org_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`,
        [ids.org, u],
      );
    await q(
      `INSERT INTO member_preference (org_id, user_id, email_digest) VALUES ($1, $2, 'off')`,
      [ids.org, ids.off],
    );
    const mkContent = async (title: string) =>
      (
        await q<{ id: string }>(
          `INSERT INTO content (org_id, kind, owner_id, title, state, publish_at) VALUES ($1, 'clip', $2, $3, 'published', now() - interval '1 hour') RETURNING id`,
          [ids.org, ids.owner, title],
        )
      )[0]!.id;
    ids.orgClip = await mkContent('Org-wide clip');
    ids.deptClip = await mkContent('Dept clip');
    ids.dept = (
      await q<{ id: string }>(
        `INSERT INTO stream (org_id, kind, slug, name) VALUES ($1, 'department', $2, 'Dept') RETURNING id`,
        [ids.org, `dept-${tag}`],
      )
    )[0]!.id;
    await q(
      `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id, subject_relation, created_by)
       VALUES ($1, 'content', $2, 'viewer', 'org', $1, 'member', $3),
              ($1, 'stream', $4, 'viewer', 'user', $5, '', $3),
              ($1, 'content', $6, 'viewer', 'stream', $4, 'viewer', $3)`,
      [ids.org, ids.orgClip, ids.owner, ids.dept, ids.lost, ids.deptClip],
    );
    // Notifications: everyone gets the org clip; `lost` also gets the dept clip, then loses the stream.
    for (const u of [ids.daily, ids.off, ids.gone, ids.lost, ids.flaky])
      await notify(u, 'content.published', ids.orgClip, 'published:org');
    await notify(ids.lost, 'content.published', ids.deptClip, 'published:dept');
    await notify(ids.daily, 'content.published', ids.deptClip, 'published:read');
    await q(
      `UPDATE notification SET read_at = now() WHERE org_id = $1 AND user_id = $2 AND dedupe_key = 'published:read'`,
      [ids.org, ids.daily],
    );
    await q(
      `DELETE FROM relation_tuple WHERE org_id = $1 AND object_type = 'stream' AND object_id = $2 AND subject_id = $3`,
      [ids.org, ids.dept, ids.lost],
    );
    await q(`UPDATE org_membership SET status = 'deactivated' WHERE org_id = $1 AND user_id = $2`, [
      ids.org,
      ids.gone,
    ]);
  });
  afterAll(async () => {
    await admin.query(`DELETE FROM org WHERE id = $1`, [ids.org]);
    await admin.query(`DELETE FROM platform.user_account WHERE email_normalized LIKE $1`, [
      `%-${tag}@example.test`,
    ]);
    await admin.end();
    await platform.end();
  });

  it('sends one digest per eligible member per day with permission-checked titles; a failed send is retried next run', async () => {
    mailer.failNextTo(email('flaky')); // one member's send fails on the first run and must be retried later
    const first = await runDigest(ctx, day);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    const sentTo = (name: string) => mailer.to(email(name));
    expect(sentTo('flaky')).toHaveLength(0);
    expect(mine()).toHaveLength(2);
    const second = await runDigest(ctx, day);
    expect(second.retried).toBeGreaterThanOrEqual(1);
    expect(sentTo('daily')).toHaveLength(1);
    expect(sentTo('lost')).toHaveLength(1);
    expect(sentTo('flaky')).toHaveLength(1);
    expect(sentTo('off')).toHaveLength(0);
    expect(sentTo('gone')).toHaveLength(0);
    expect(sentTo('owner')).toHaveLength(0); // no notifications
    const daily = sentTo('daily')[0]!;
    expect(daily.text).toContain('"Org-wide clip"');
    expect(daily.text).not.toContain('Dept clip'); // read before the run
    expect(daily.text).toContain(`https://os.example/content/${ids.orgClip}`);
    const lost = sentTo('lost')[0]!;
    expect(lost.text).toContain('"Org-wide clip"');
    expect(lost.text).not.toContain('Dept clip'); // access lost since the notification
    expect(lost.text).toContain('An item you can no longer view had an update.');
    expect(lost.text).not.toContain(`/content/${ids.deptClip}`);
    // Third run the same day: nothing new, nothing repeated for this org.
    await runDigest(ctx, day);
    expect(mine()).toHaveLength(3);
    const rows = await q<{
      user_id: string;
      status: string;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT user_id, status, attempts, last_error FROM email_digest WHERE org_id = $1 ORDER BY user_id`,
      [ids.org],
    );
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
    expect(rows.find((r) => r.user_id === ids.flaky)!.attempts).toBe(2); // the retried one
    expect(rows.find((r) => r.user_id === ids.flaky)!.last_error).toBeNull();
    expect(errors.some((e) => e.includes('digest send failed'))).toBe(true);
    const undigested = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification WHERE org_id = $1 AND digested_at IS NULL AND read_at IS NULL`,
      [ids.org],
    );
    expect(undigested[0]!.n).toBe(2); // off + gone: never claimed, never emailed
  });

  it('a claim left pending by a crash is retried after 30 minutes; a fresh pending claim is not (review M2)', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const stale = (
      await q<{ id: string }>(
        `SELECT platform_notify($1, $2, 'content.published', 'audience', $3, NULL, NULL, 'published:stale', '{}'::jsonb)`,
        [ids.org, ids.daily, ids.orgClip],
      )
    ).length;
    expect(stale).toBe(1);
    const staleId = (
      await q<{ id: string }>(
        `SELECT id FROM notification WHERE org_id = $1 AND user_id = $2 AND dedupe_key = 'published:stale'`,
        [ids.org, ids.daily],
      )
    )[0]!.id;
    expect(
      (
        await q<{ ok: boolean }>(`SELECT platform_digest_claim($1, $2, $3, $4::uuid[]) AS ok`, [
          ids.org,
          ids.daily,
          tomorrow,
          [staleId],
        ])
      )[0]!.ok,
    ).toBe(true);
    await q(
      `UPDATE email_digest SET claimed_at = now() - interval '45 minutes' WHERE org_id = $1 AND user_id = $2 AND digest_date = $3`,
      [ids.org, ids.daily, tomorrow],
    );
    // A fresh claim for another member stays pending (its worker may still be sending).
    await q(
      `SELECT platform_notify($1, $2, 'content.published', 'audience', $3, NULL, NULL, 'published:fresh', '{}'::jsonb)`,
      [ids.org, ids.flaky, ids.orgClip],
    );
    const freshId = (
      await q<{ id: string }>(
        `SELECT id FROM notification WHERE org_id = $1 AND user_id = $2 AND dedupe_key = 'published:fresh'`,
        [ids.org, ids.flaky],
      )
    )[0]!.id;
    await q(`SELECT platform_digest_claim($1, $2, $3, $4::uuid[])`, [
      ids.org,
      ids.flaky,
      tomorrow,
      [freshId],
    ]);
    const before = mine().length;
    const run = await runDigest(ctx, tomorrow);
    expect(run.retried).toBeGreaterThanOrEqual(1);
    expect(mine()).toHaveLength(before + 1);
    expect(mailer.to(email('daily'))).toHaveLength(2);
    expect(mailer.to(email('flaky'))).toHaveLength(1); // unchanged: the fresh claim was not resent
    const rows = await q<{ user_id: string; status: string }>(
      `SELECT user_id, status FROM email_digest WHERE org_id = $1 AND digest_date = $2 ORDER BY user_id`,
      [ids.org, tomorrow],
    );
    expect(rows.find((r) => r.user_id === ids.daily)!.status).toBe('sent');
    expect(rows.find((r) => r.user_id === ids.flaky)!.status).toBe('pending');
  });

  it('comment.created notifies the content owner and the root author once, never the commenter', async () => {
    const root = (
      await q<{ id: string }>(
        `INSERT INTO comment (org_id, content_id, author_id, body, body_hash) VALUES ($1, $2, $3, 'root', sha256('root')) RETURNING id`,
        [ids.org, ids.orgClip, ids.daily],
      )
    )[0]!.id;
    const reply = (
      await q<{ id: string }>(
        `INSERT INTO comment (org_id, content_id, root_id, author_id, body, body_hash) VALUES ($1, $2, $3, $4, 'reply', sha256('reply')) RETURNING id`,
        [ids.org, ids.orgClip, root, ids.flaky],
      )
    )[0]!.id;
    const ev = (commentId: string) => ({
      id: '0',
      org_id: ids.org,
      type: 'comment.created',
      subject_type: 'content',
      subject_id: ids.orgClip,
      version_id: null,
      payload: { commentId },
    });
    expect(await dispatchEvent(platform, ctx, ev(root))).toBe('comment fan-out: 1/1');
    expect(await dispatchEvent(platform, ctx, ev(reply))).toBe('comment fan-out: 2/2');
    expect(await dispatchEvent(platform, ctx, ev(reply))).toBe('comment fan-out: 0/2'); // replay: deduped
    const notes = await q<{ user_id: string; reason: string }>(
      `SELECT user_id, reason FROM notification WHERE org_id = $1 AND kind = 'comment.created' ORDER BY created_at`,
      [ids.org],
    );
    expect(notes).toEqual([
      { user_id: ids.owner, reason: 'commented' },
      { user_id: ids.owner, reason: 'commented' },
      { user_id: ids.daily, reason: 'replied' },
    ]);
  });

  it('retention prunes raw engagement events older than the org setting; search prune drops non-current rows', async () => {
    await q(
      `INSERT INTO engagement_event (org_id, user_id, content_id, version_id, type, session_key, at)
       VALUES ($1, $2, $3, gen_random_uuid(), 'view_start', 'old', now() - interval '400 days'),
              ($1, $2, $3, gen_random_uuid(), 'view_start', 'new', now() - interval '1 day')`,
      [ids.org, ids.daily, ids.orgClip],
    );
    const r = await runEngagementRetention(ctx);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const left = await q<{ session_key: string }>(
      `SELECT session_key FROM engagement_event WHERE org_id = $1 AND content_id = $2`,
      [ids.org, ids.orgClip],
    );
    expect(left.map((x) => x.session_key)).toEqual(['new']);

    const v = (
      await q<{ id: string }>(
        `INSERT INTO content_version (org_id, content_id, status, transcript) VALUES ($1, $2, 'current', '{"language":"en","segments":[{"start_ms":0,"end_ms":1000,"text":"hello world"}]}'::jsonb) RETURNING id`,
        [ids.org, ids.orgClip],
      )
    )[0]!.id;
    expect(
      (
        await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM chunk WHERE content_version_id = $1`,
          [v],
        )
      )[0]!.n,
    ).toBe(1);
    await q(`UPDATE content_version SET status = 'superseded' WHERE org_id = $1 AND id = $2`, [
      ids.org,
      v,
    ]);
    const p = await runSearchPrune(ctx);
    expect(p.deleted).toBeGreaterThanOrEqual(1);
    expect(
      (
        await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM chunk WHERE content_version_id = $1`,
          [v],
        )
      )[0]!.n,
    ).toBe(0);
  });
});
