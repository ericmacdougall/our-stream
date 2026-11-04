// SPDX-License-Identifier: AGPL-3.0-only
// writeTuple/deleteTuple rules exercised through withTenant as the RLS-bound app role (code-inspection F2).
// One positive and one negative case per rule; plus F1 (epoch sequence isolation) and F4 (deactivated
// members never regain derived rows) checks that need the app role.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool, runMigrations, withTenant, type TenantContext } from '@our-stream/db';
import { buildFixture, type FixtureOrg } from './fixture.js';
import type { Tuple } from './model.js';
import { deleteTuple, writeTuple, type AuthzRuleError } from './write-tuples.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const appUrl = process.env['DATABASE_URL'];

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

async function seed(admin: pg.Client, org: FixtureOrg, users: Record<string, string>) {
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
      `INSERT INTO content (org_id, id, kind, owner_id, title, state, publish_at, expires_at, retracted_at, review_requested) VALUES ($1, $2, 'clip', $3, $4, $5, $6, $7, $8, $9)`,
      [
        org.orgId,
        c.id,
        c.ownerId,
        `t ${c.id.slice(0, 8)}`,
        c.state,
        c.publishAt,
        c.expiresAt,
        c.retractedAt,
        c.reviewRequested,
      ],
    );
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
  void users;
}

describe.skipIf(!adminUrl || !appUrl)(
  'writeTuple / deleteTuple rules as the app role (integration)',
  () => {
    const fixture = buildFixture('-wt');
    const [acme, globex] = fixture.orgs;
    const u = fixture.users;
    const admin = new pg.Client({ connectionString: adminUrl });
    const pool = createPool(appUrl ?? '');
    const as = (userId: string, org: FixtureOrg = acme): TenantContext => ({
      orgId: org.orgId,
      userId,
    });

    beforeAll(async () => {
      await runMigrations(adminUrl!);
      await admin.connect();
      await admin.query('BEGIN');
      await admin.query(`DELETE FROM org WHERE slug IN ('acme-wt','globex-wt')`);
      await admin.query(`DELETE FROM platform.user_account WHERE email_normalized LIKE 'wt-%'`);
      for (const [name, id] of Object.entries(u)) {
        await admin.query(
          'INSERT INTO platform.user_account (id, email, email_normalized, display_name) VALUES ($1, $2, $2, $3)',
          [id, `wt-${name}-${id.slice(0, 8)}@example.invalid`, name],
        );
      }
      await seed(admin, acme, u);
      await seed(admin, globex, u);
      await admin.query('COMMIT');
    });
    afterAll(async () => {
      await admin.query(`DELETE FROM org WHERE slug IN ('acme-wt','globex-wt')`);
      await admin.query(`DELETE FROM platform.user_account WHERE email_normalized LIKE 'wt-%'`);
      await admin.end();
      await pool.end();
    });

    const expectRule = async (ctx: TenantContext, t: Tuple, code: string) => {
      await expect(withTenant(pool, ctx, (c) => writeTuple(c, t))).rejects.toMatchObject({
        code,
      } satisfies Partial<AuthzRuleError>);
    };
    const ok = (ctx: TenantContext, t: Tuple) => withTenant(pool, ctx, (c) => writeTuple(c, t));
    const audienceOf = async (contentId: string) =>
      withTenant(pool, as(u.admin), async (c) => {
        const r = await c.query<{ kind: string; principal_id: string }>(
          'SELECT kind, principal_id FROM content_audience WHERE org_id = $1 AND content_id = $2',
          [acme.orgId, contentId],
        );
        return r.rows.map((x) => `${x.kind}:${x.principal_id}`);
      });

    it('stream audience: contributor on the stream may publish, a plain viewer may not', async () => {
      const c = acme.contentNames.noAudience; // owner: contributor
      await expectRule(
        as(u.member),
        tuple('content', c, 'viewer', 'stream', acme.streamNames.company, 'viewer'),
        'not_author',
      );
      await ok(
        as(u.contributor),
        tuple('content', c, 'viewer', 'stream', acme.streamNames.company, 'viewer'),
      );
      expect(await audienceOf(c)).toContain(`stream:${acme.streamNames.company}`);
      // contributor is only a viewer of the private stream (no role at all): refused
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'stream', acme.streamNames.private, 'viewer'),
        'stream_forbidden',
      );
    });

    it('org-wide audience requires announcer or admin', async () => {
      const c = acme.contentNames.noAudience;
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'org', acme.orgId, 'member'),
        'org_wide_forbidden',
      );
      // announcer is not the owner: not_author first; make the announcer an editor via the owner, then it works
      await ok(as(u.contributor), tuple('content', c, 'editor', 'user', u.announcer));
      await ok(as(u.announcer), tuple('content', c, 'viewer', 'org', acme.orgId, 'member'));
      expect(await audienceOf(c)).toContain(`org:${acme.orgId}`);
      await expectRule(
        as(u.announcer),
        tuple('content', c, 'viewer', 'org', globex.orgId, 'member'),
        'bad_subject',
      );
    });

    it('group audience requires membership of the group; nonexistent groups are refused', async () => {
      const c = acme.contentNames.noAudience;
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'group', acme.groupNames.backend),
        'group_forbidden',
      ); // contributor is in engineering, not backend
      await ok(
        as(u.contributor),
        tuple('content', c, 'viewer', 'group', acme.groupNames.engineering),
      );
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'group', '00000000-0000-4000-8000-000000000001'),
        'no_such_group',
      );
    });

    it('direct grants only to active members; subject relations are validated', async () => {
      const c = acme.contentNames.noAudience;
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'user', u.deactivated),
        'target_inactive',
      );
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'user', u.outsider),
        'target_inactive',
      );
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'user', u.member, 'member'),
        'bad_subject',
      );
      await ok(as(u.contributor), tuple('content', c, 'viewer', 'user', u.member));
    });

    it('private-stream content cannot be re-targeted outside the stream by non-moderators (ADR-0002)', async () => {
      const c = acme.contentNames.privatePublished; // owner: admin; audience: private stream
      // give the contributor editor rights so only the private-stream rule stands in the way
      await ok(as(u.admin), tuple('content', c, 'editor', 'user', u.contributor));
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'user', u.member),
        'private_stream_retarget',
      );
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'stream', acme.streamNames.company, 'viewer'),
        'private_stream_retarget',
      );
      // the same private stream is exempt from the re-target guard, but the ordinary stream rule still applies:
      // the contributor holds no role on the private stream, so even an idempotent re-add is refused
      await expectRule(
        as(u.contributor),
        tuple('content', c, 'viewer', 'stream', acme.streamNames.private, 'viewer'),
        'stream_forbidden',
      );
      // the private stream owner (admin) may widen it
      await ok(as(u.admin), tuple('content', c, 'viewer', 'user', u.member));
    });

    it('N1: a non-moderator cannot remove a private stream from an audience (delete-then-add bypass)', async () => {
      const c = acme.contentNames.privatePublished; // contributor is an editor (granted above), not a private-stream moderator
      await expect(
        withTenant(pool, as(u.contributor), (cl) =>
          deleteTuple(
            cl,
            tuple('content', c, 'viewer', 'stream', acme.streamNames.private, 'viewer'),
          ),
        ),
      ).rejects.toMatchObject({ code: 'private_stream_retarget' });
      expect(await audienceOf(c)).toContain(`stream:${acme.streamNames.private}`);
    });

    it('M1: a fresh org reports epoch 0 before its first content change, then a positive epoch', async () => {
      const fresh = await admin.query<{ id: string }>(
        `INSERT INTO org (slug, name) VALUES ('fresh-wt', 'fresh') RETURNING id`,
      );
      const id = fresh.rows[0]!.id;
      await admin.query(`SELECT set_config('app.org_id', $1, false)`, [id]);
      const before = await admin.query<{ e: string }>(
        'SELECT current_org_content_epoch($1)::text AS e',
        [id],
      );
      expect(Number(before.rows[0]!.e)).toBe(0);
      await admin.query(
        `INSERT INTO org_membership (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [id, u.owner],
      );
      await admin.query(
        `INSERT INTO content (org_id, kind, owner_id, title) VALUES ($1, 'clip', $2, 'first')`,
        [id, u.owner],
      );
      const after = await admin.query<{ e: string }>(
        'SELECT current_org_content_epoch($1)::text AS e',
        [id],
      );
      expect(Number(after.rows[0]!.e)).toBeGreaterThan(0);
      await admin.query(`DELETE FROM org WHERE id = $1`, [id]);
    });

    it('group membership: admin only; cycles and depth beyond 4 are refused', async () => {
      const g = acme.groupNames;
      await expectRule(
        as(u.contributor),
        tuple('group', g.backend, 'member', 'user', u.member),
        'admin_required',
      );
      await expectRule(
        as(u.admin),
        tuple('group', g.platform, 'member', 'group', g.engineering),
        'group_cycle',
      ); // engineering ⊃ backend ⊃ platform
      // engineering(1) ⊃ backend(2) ⊃ platform(3) ⊃ secret(4) is allowed; one more level is not
      await ok(as(u.admin), tuple('group', g.platform, 'member', 'group', g.secret));
      const deep = await withTenant(pool, as(u.admin), async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO "group" (org_id, name) VALUES ($1, 'deep') RETURNING id`,
          [acme.orgId],
        );
        return r.rows[0]!.id;
      });
      await expectRule(
        as(u.admin),
        tuple('group', g.secret, 'member', 'group', deep),
        'group_depth',
      );
      await expectRule(
        as(u.admin),
        tuple('group', g.backend, 'member', 'stream', acme.streamNames.company),
        'bad_subject',
      );
    });

    it('stream roles: stream owner or admin only; everyone may only be viewer', async () => {
      const s = acme.streamNames.department;
      await expectRule(
        as(u.moderator),
        tuple('stream', s, 'contributor', 'user', u.member),
        'stream_owner_required',
      );
      await ok(as(u.admin), tuple('stream', s, 'contributor', 'user', u.member));
      await expectRule(
        as(u.admin),
        tuple('stream', s, 'moderator', 'org', acme.orgId, 'member'),
        'bad_subject',
      );
      await expectRule(
        as(u.admin),
        tuple('stream', s, 'viewer', 'stream', acme.streamNames.company),
        'bad_subject',
      );
      await expectRule(
        as(u.admin),
        tuple('stream', '00000000-0000-4000-8000-000000000002', 'viewer', 'user', u.member),
        'no_such_stream',
      );
    });

    it('deactivated actors and other-org actors cannot write; org tuples are refused', async () => {
      await expectRule(
        as(u.deactivated),
        tuple('content', acme.contentNames.noAudience, 'viewer', 'user', u.member),
        'not_member',
      );
      await expectRule(
        as(u.outsider),
        tuple('content', acme.contentNames.noAudience, 'viewer', 'user', u.member),
        'not_member',
      );
      await expectRule(
        as(u.admin),
        tuple('org', acme.orgId, 'admin', 'user', u.member),
        'bad_object',
      );
    });

    it('deleteTuple: editors may remove audience entries, unknown object types are refused, revocation is immediate', async () => {
      const c = acme.contentNames.noAudience;
      await withTenant(pool, as(u.announcer), (cl) =>
        deleteTuple(cl, tuple('content', c, 'viewer', 'user', u.member)),
      );
      expect(await audienceOf(c)).not.toContain(`user:${u.member}`);
      await expect(
        withTenant(pool, as(u.admin), (cl) =>
          deleteTuple(cl, {
            ...tuple('content', c, 'viewer', 'user', u.member),
            objectType: 'org',
          }),
        ),
      ).rejects.toMatchObject({ code: 'bad_object' });
      await expect(
        withTenant(pool, as(u.member), (cl) =>
          deleteTuple(cl, tuple('content', c, 'viewer', 'group', acme.groupNames.engineering)),
        ),
      ).rejects.toMatchObject({ code: 'not_author' });
    });

    it('F1: the app role cannot read or advance another org epoch sequence, and cannot list org sequences', async () => {
      const seq = `platform.org_epoch_${globex.orgId.replace(/-/g, '')}`;
      // Each forbidden statement runs in its own transaction: a permission error aborts the transaction.
      const denied = (sql: string, params: unknown[] = []) =>
        expect(withTenant(pool, as(u.admin), (c) => c.query(sql, params))).rejects.toThrow(
          /permission denied/,
        );
      await denied(`SELECT last_value FROM ${seq}`);
      await denied(`SELECT nextval($1)`, [seq]);
      await expect(
        withTenant(pool, as(u.admin), (c) =>
          c.query('SELECT next_org_content_epoch($1)', [globex.orgId]),
        ),
      ).rejects.toThrow(/org context mismatch/);
      await expect(
        withTenant(pool, as(u.admin), (c) =>
          c.query('SELECT current_org_content_epoch($1)', [globex.orgId]),
        ),
      ).rejects.toThrow(/org context mismatch/);
      await withTenant(pool, as(u.admin), async (c) => {
        const own = await c.query<{ e: string }>(
          'SELECT current_org_content_epoch($1)::text AS e',
          [acme.orgId],
        );
        expect(Number(own.rows[0]!.e)).toBeGreaterThan(0);
        const listed = await c.query<{ relname: string }>(
          `SELECT relname FROM pg_class WHERE relname LIKE 'org_epoch_%' AND has_sequence_privilege(oid, 'SELECT')`,
        );
        expect(listed.rows).toEqual([]);
      });
    });

    it('F4: a deactivated member never regains derived access rows when related tuples change', async () => {
      await admin.query(`SELECT set_config('app.org_id', $1, false)`, [acme.orgId]);
      await admin.query(
        `UPDATE org_membership SET status = 'deactivated' WHERE org_id = $1 AND user_id = $2`,
        [acme.orgId, u.member2],
      );
      // touch the group and stream the member was linked to
      await admin.query(
        `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id) VALUES ($1,'group',$2,'member','user',$3)`,
        [acme.orgId, acme.groupNames.platform, u.privateMember],
      );
      await admin.query(
        `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id) VALUES ($1,'stream',$2,'viewer','user',$3)`,
        [acme.orgId, acme.streamNames.department, u.privateMember],
      );
      const rows = await admin.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM user_stream_access WHERE org_id = $1 AND user_id = $2)::int + (SELECT count(*) FROM user_group_membership WHERE org_id = $1 AND user_id = $2)::int AS n`,
        [acme.orgId, u.member2],
      );
      expect(rows.rows[0]!.n).toBe(0);
      await admin.query(
        `UPDATE org_membership SET status = 'active' WHERE org_id = $1 AND user_id = $2`,
        [acme.orgId, u.member2],
      );
    });

    it('F7: the app role has no direct access to platform tables and emits events only in its own org', async () => {
      const denied = (sql: string, params: unknown[] = []) =>
        expect(withTenant(pool, as(u.admin), (c) => c.query(sql, params))).rejects.toThrow(
          /permission denied/,
        );
      await denied('SELECT 1 FROM platform.user_account LIMIT 1');
      await denied('SELECT 1 FROM platform.session LIMIT 1');
      await denied(
        `INSERT INTO platform.domain_event (org_id, type, subject_type, subject_id) VALUES ($1, 'x', 'content', $2)`,
        [globex.orgId, acme.contentNames.noAudience],
      );
      await withTenant(pool, as(u.admin), async (c) => {
        const id = await c.query<{ id: string }>(
          `SELECT platform_emit_event('content.published', 'content', $1, NULL, '{}'::jsonb) AS id`,
          [acme.contentNames.noAudience],
        );
        expect(Number(id.rows[0]!.id)).toBeGreaterThan(0);
      });
      const ev = await admin.query<{ org_id: string }>(
        'SELECT org_id FROM platform.domain_event ORDER BY id DESC LIMIT 1',
      );
      expect(ev.rows[0]!.org_id).toBe(acme.orgId);
    });
  },
);
