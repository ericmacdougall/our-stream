// SPDX-License-Identifier: AGPL-3.0-only
// M0-2 and M0-3: the SQL predicates agree with the reference implementation on every matrix cell,
// both through the RLS-bound application role and through a superuser connection (RLS bypassed), and
// every chunk returned by a permission-filtered search satisfies readerVisible (subset property).
// Controls: a predicate without the active-membership check, and a chunk query without the
// predicate, must disagree with the reference.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import pg from 'pg';
import { createPool, runMigrations, withTenant } from '@our-stream/db';
import { buildFixture, NOW, type FixtureOrg } from './fixture.js';
import { authorAccessible, readerVisible } from './reference.js';
import { authorAccessibleSql, readerVisibleSql } from './sql.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const appUrl = process.env['DATABASE_URL'];
const NOW_SQL = `'${NOW.toISOString()}'::timestamptz`;

async function seedOrg(admin: pg.Client, org: FixtureOrg, users: Record<string, string>) {
  await admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
  await admin.query('INSERT INTO org (id, slug, name) VALUES ($1, $2, $2)', [org.orgId, org.slug]);
  for (const m of org.memberships) {
    await admin.query(
      'INSERT INTO org_membership (org_id, user_id, role, status) VALUES ($1, $2, $3, $4)',
      [org.orgId, m.userId, m.role, m.status],
    );
  }
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
      `INSERT INTO content_version (org_id, content_id, status) VALUES ($1, $2, 'current') RETURNING id`,
      [org.orgId, c.id],
    );
    await admin.query('UPDATE content SET current_version_id = $3 WHERE org_id = $1 AND id = $2', [
      org.orgId,
      c.id,
      v.rows[0]!.id,
    ]);
    for (let i = 0; i < 3; i += 1) {
      await admin.query(
        `INSERT INTO chunk (org_id, content_version_id, content_id, text, locator) VALUES ($1, $2, $3, $4, $5)`,
        [
          org.orgId,
          v.rows[0]!.id,
          c.id,
          `${org.slug} onboarding policy chunk ${i} for ${c.id.slice(0, 8)}`,
          JSON.stringify({ t: i * 30 }),
        ],
      );
    }
  }
  // Tuples are inserted last so triggers see memberships, groups and streams.
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

describe.skipIf(!adminUrl || !appUrl)('authz fixture matrix (integration)', () => {
  const fixture = buildFixture();
  const admin = new pg.Client({ connectionString: adminUrl });
  const pool = createPool(appUrl ?? '');

  beforeAll(async () => {
    await runMigrations(adminUrl!);
    await admin.connect();
    await admin.query('BEGIN');
    // Orgs first: content.owner_id references org_membership with RESTRICT; dropping the org cascades content away.
    await admin.query(`DELETE FROM org WHERE slug IN ('acme','globex')`);
    await admin.query(`DELETE FROM platform.user_account WHERE email_normalized LIKE 'matrix-%'`);
    for (const [name, id] of Object.entries(fixture.users)) {
      await admin.query(
        'INSERT INTO platform.user_account (id, email, email_normalized, display_name) VALUES ($1, $2, $2, $3)',
        [id, `matrix-${name}-${id.slice(0, 8)}@example.invalid`, name],
      );
    }
    for (const org of fixture.orgs) await seedOrg(admin, org, fixture.users);
    await admin.query('COMMIT');
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM org WHERE slug IN ('acme','globex')`);
    await admin.query(`DELETE FROM platform.user_account WHERE email_normalized LIKE 'matrix-%'`);
    await admin.end();
    await pool.end();
  });

  async function sqlReaderVisibleApp(org: FixtureOrg, userId: string): Promise<Set<string>> {
    return withTenant(pool, { orgId: org.orgId, userId }, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT c.id FROM content c WHERE ${readerVisibleSql({ org: '$1', user: '$2', now: NOW_SQL })}`,
        [org.orgId, userId],
      );
      return new Set(r.rows.map((x) => x.id));
    });
  }
  async function sqlReaderVisibleAdmin(org: FixtureOrg, userId: string): Promise<Set<string>> {
    const r = await admin.query<{ id: string }>(
      `SELECT c.id FROM content c WHERE ${readerVisibleSql({ org: '$1', user: '$2', now: NOW_SQL })}`,
      [org.orgId, userId],
    );
    return new Set(r.rows.map((x) => x.id));
  }
  async function sqlAuthorAccessible(org: FixtureOrg, userId: string): Promise<Set<string>> {
    return withTenant(pool, { orgId: org.orgId, userId }, async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT c.id FROM content c WHERE ${authorAccessibleSql({ org: '$1', user: '$2' })}`,
        [org.orgId, userId],
      );
      return new Set(r.rows.map((x) => x.id));
    });
  }

  it('readerVisible: SQL through the app role agrees with the reference on every (org, user, content) cell', async () => {
    let cells = 0;
    for (const org of fixture.orgs) {
      for (const userId of Object.values(fixture.users)) {
        const got = await sqlReaderVisibleApp(org, userId);
        for (const c of org.content) {
          cells += 1;
          expect(got.has(c.id), `org=${org.slug} user=${userId} content=${c.id}`).toBe(
            readerVisible(org, userId, c.id, NOW),
          );
        }
        // Cross-org: the other org's content never appears, even with the same user ids.
        const other = fixture.orgs.find((o) => o !== org)!;
        for (const c of other.content) expect(got.has(c.id)).toBe(false);
      }
    }
    expect(cells).toBeGreaterThan(200);
  });

  it('readerVisible: SQL with RLS bypassed (superuser) still agrees, proving the predicate alone is sufficient', async () => {
    for (const org of fixture.orgs) {
      for (const userId of Object.values(fixture.users)) {
        const got = await sqlReaderVisibleAdmin(org, userId);
        for (const c of org.content)
          expect(got.has(c.id)).toBe(readerVisible(org, userId, c.id, NOW));
        const other = fixture.orgs.find((o) => o !== org)!;
        for (const c of other.content) expect(got.has(c.id)).toBe(false);
      }
    }
  });

  it('authorAccessible: SQL agrees with the reference on every cell', async () => {
    for (const org of fixture.orgs) {
      for (const userId of Object.values(fixture.users)) {
        const got = await sqlAuthorAccessible(org, userId);
        for (const c of org.content) {
          expect(got.has(c.id), `org=${org.slug} user=${userId} content=${c.id}`).toBe(
            authorAccessible(org, userId, c.id),
          );
        }
      }
    }
  });

  it('control: a predicate without the active-membership check disagrees with the reference', async () => {
    const [acme] = fixture.orgs;
    const broken = readerVisibleSql({ org: '$1', user: '$2', now: NOW_SQL }).replace(
      /EXISTS \(SELECT 1 FROM org_membership m WHERE m\.org_id = \$1 AND m\.user_id = \$2 AND m\.status = 'active'\)/,
      'TRUE',
    );
    expect(broken).not.toEqual(readerVisibleSql({ org: '$1', user: '$2', now: NOW_SQL }));
    const r = await admin.query<{ id: string }>(`SELECT c.id FROM content c WHERE ${broken}`, [
      acme.orgId,
      fixture.users.deactivated,
    ]);
    const got = new Set(r.rows.map((x) => x.id));
    const disagreements = acme.content.filter(
      (c) => got.has(c.id) !== readerVisible(acme, fixture.users.deactivated!, c.id, NOW),
    );
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it('revocation is synchronous: removing a user from a nested group hides content on the next query, with no job', async () => {
    const [acme] = fixture.orgs;
    const before = await sqlReaderVisibleApp(acme, fixture.users.member2!);
    expect(before.has(acme.contentNames.deptPublished)).toBe(true);
    const epochBefore = await admin.query<{ e: string }>(
      'SELECT authz_epoch::text AS e FROM org_membership WHERE org_id = $1 AND user_id = $2',
      [acme.orgId, fixture.users.member2],
    );
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [acme.orgId]);
    await admin.query(
      `DELETE FROM relation_tuple WHERE org_id = $1 AND object_type = 'group' AND object_id = $2 AND subject_type = 'user' AND subject_id = $3`,
      [acme.orgId, acme.groupNames.platform, fixture.users.member2],
    );
    const after = await sqlReaderVisibleApp(acme, fixture.users.member2!);
    expect(after.has(acme.contentNames.deptPublished)).toBe(false);
    expect(after.has(acme.contentNames.groupPublished)).toBe(false);
    const epochAfter = await admin.query<{ e: string }>(
      'SELECT authz_epoch::text AS e FROM org_membership WHERE org_id = $1 AND user_id = $2',
      [acme.orgId, fixture.users.member2],
    );
    expect(Number(epochAfter.rows[0]!.e)).toBeGreaterThan(Number(epochBefore.rows[0]!.e));
    // restore for later tests
    await admin.query(
      `INSERT INTO relation_tuple (org_id, object_type, object_id, relation, subject_type, subject_id) VALUES ($1,'group',$2,'member','user',$3)`,
      [acme.orgId, acme.groupNames.platform, fixture.users.member2],
    );
  });

  it('deactivation revokes synchronously and bumps the epoch', async () => {
    const [acme] = fixture.orgs;
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [acme.orgId]);
    await admin.query(
      `UPDATE org_membership SET status = 'deactivated' WHERE org_id = $1 AND user_id = $2`,
      [acme.orgId, fixture.users.member],
    );
    const got = await sqlReaderVisibleApp(acme, fixture.users.member!);
    expect(got.size).toBe(0);
    await admin.query(
      `UPDATE org_membership SET status = 'active' WHERE org_id = $1 AND user_id = $2`,
      [acme.orgId, fixture.users.member],
    );
    const back = await sqlReaderVisibleApp(acme, fixture.users.member!);
    expect(back.has(acme.contentNames.companyPublished)).toBe(true);
  });

  it('retrieval subset property: every chunk returned by a filtered search satisfies readerVisible', async () => {
    const userIds = Object.values(fixture.users);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...fixture.orgs),
        fc.constantFrom(...userIds),
        fc.constantFrom('onboarding', 'policy', 'chunk', 'acme', 'globex'),
        async (org, userId, term) => {
          const rows = await withTenant(pool, { orgId: org.orgId, userId }, async (client) => {
            const r = await client.query<{ content_id: string }>(
              `SELECT ch.content_id FROM chunk ch JOIN content c ON c.org_id = ch.org_id AND c.id = ch.content_id
             JOIN content_version v ON v.org_id = ch.org_id AND v.id = ch.content_version_id AND v.status = 'current'
             WHERE ch.org_id = $1 AND ch.tsv @@ plainto_tsquery('simple', $3) AND ${readerVisibleSql({ org: '$1', user: '$2', now: NOW_SQL })}`,
              [org.orgId, userId, term],
            );
            return r.rows;
          });
          for (const row of rows) {
            if (!readerVisible(org, userId, row.content_id, NOW)) return false;
          }
          return true;
        },
      ),
      { numRuns: 60, seed: 20261103, verbose: true },
    );
  });

  it('control: a chunk query without the predicate returns chunks the user may not see', async () => {
    const [acme] = fixture.orgs;
    const rows = await withTenant(
      pool,
      { orgId: acme.orgId, userId: fixture.users.member! },
      async (client) => {
        const r = await client.query<{ content_id: string }>(
          `SELECT ch.content_id FROM chunk ch WHERE ch.org_id = $1 AND ch.tsv @@ plainto_tsquery('simple', 'chunk')`,
          [acme.orgId],
        );
        return r.rows;
      },
    );
    const leaked = rows.filter(
      (r) => !readerVisible(acme, fixture.users.member!, r.content_id, NOW),
    );
    expect(leaked.length).toBeGreaterThan(0);
  });

  it('RLS: the app role sees nothing without tenant context and nothing from another org', async () => {
    const client = await pool.connect();
    try {
      const none = await client.query('SELECT count(*)::int AS n FROM content');
      expect(none.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
    const [acme, globex] = fixture.orgs;
    const n = await withTenant(
      pool,
      { orgId: acme.orgId, userId: fixture.users.member! },
      async (client) => {
        const r = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM content WHERE org_id = $1',
          [globex.orgId],
        );
        return r.rows[0]!.n;
      },
    );
    expect(n).toBe(0);
  });
});
