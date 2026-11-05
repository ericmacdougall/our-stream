// SPDX-License-Identifier: AGPL-3.0-only
// M0-2 and M0-3: the SQL predicates agree with the reference implementation on every matrix cell,
// both through the RLS-bound application role and through a superuser connection (RLS bypassed), and
// every chunk returned by a permission-filtered search satisfies readerVisible (subset property).
// Controls: a predicate without the active-membership check, and a chunk query without the
// predicate, must disagree with the reference.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@our-stream/db';
import { buildFixture, NOW, type FixtureOrg } from './fixture.js';
import { authorAccessible, readerVisible } from './reference.js';
import { authorAccessibleSql, documentGateSql, readerVisibleSql } from './sql.js';

const adminUrl = process.env['DATABASE_ADMIN_URL'];
const appUrl = process.env['DATABASE_URL'];
const NOW_SQL = `'${NOW.toISOString()}'::timestamptz`;

async function seedOrg(admin: pg.Client, org: FixtureOrg, users: Record<string, string>) {
  await admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
  await admin.query('INSERT INTO org (id, slug, name, settings) VALUES ($1, $2, $2, $3::jsonb)', [
    org.orgId,
    org.slug,
    JSON.stringify({ documents_enabled: org.documentsEnabled }),
  ]);
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
       VALUES ($1, $2, $10::content_kind, $3, $4, $5, $6, $7, $8, $9)`,
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
        c.kind,
      ],
    );
    if (c.currentVersionStatus === null) continue; // a document without any version row
    const v = await admin.query<{ id: string }>(
      `INSERT INTO content_version (org_id, content_id, status) VALUES ($1, $2, $3) RETURNING id`,
      [org.orgId, c.id, c.currentVersionStatus],
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
  const fixture = buildFixture('', { documents: true });
  // The matrix toggles deployment-global state (the documents kill switch), so it runs in its own database
  // and never disturbs suites that share DATABASE_ADMIN_URL.
  const scratchName = `matrix_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const swapDb = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${scratchName}`;
    return u.toString();
  };
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: adminUrl });
    await root.connect();
    await root.query(`CREATE DATABASE ${scratchName}`);
    await root.query(
      `GRANT CONNECT ON DATABASE ${scratchName} TO ourstream_app, ourstream_platform`,
    );
    await root.end();
    await runMigrations(swapDb(adminUrl!));
    admin = new pg.Client({ connectionString: swapDb(adminUrl!) });
    pool = createPool(swapDb(appUrl!));
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
    await admin.end();
    await pool.end();
    const root = new pg.Client({ connectionString: adminUrl });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
    await root.end();
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
    // The document gate (platform_documents_enabled) asserts the org equals the tenant context.
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [org.orgId]);
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
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [acme.orgId]);
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

  // ---------------------------------------------------------------------------------------------
  // M2a document gate: kind, current-version status, org flag and deployment kill switch.
  // ---------------------------------------------------------------------------------------------
  const docIds = (org: FixtureOrg) => new Set(Object.values(org.documentNames) as string[]);

  async function allVisibleDocs(org: FixtureOrg): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (const [name, userId] of Object.entries(fixture.users)) {
      const got = await sqlReaderVisibleApp(org, userId);
      out.set(name, new Set([...got].filter((id) => docIds(org).has(id))));
    }
    return out;
  }

  it('documents: SQL agrees with the reference; permitted roles see a non-zero number of documents', async () => {
    const [acme, globex] = fixture.orgs;
    expect(docIds(acme).size).toBeGreaterThanOrEqual(10);
    const visible = await allVisibleDocs(acme);
    for (const [name, userId] of Object.entries(fixture.users)) {
      for (const id of docIds(acme)) {
        expect(visible.get(name)!.has(id), `acme ${name} ${id}`).toBe(
          readerVisible(acme, userId, id, NOW),
        );
      }
    }
    // Positive polarity: the documents a role may see are not an empty set (a vacuous matrix fails here).
    expect(visible.get('member')!.size).toBeGreaterThan(0);
    expect(visible.get('contributor')!.size).toBeGreaterThanOrEqual(2);
    expect(visible.get('member')!.has(acme.documentNames.docCompany!)).toBe(true);
    expect(visible.get('member')!.has(acme.documentNames.docDirect!)).toBe(true);
    expect(visible.get('member2')!.has(acme.documentNames.docDirect!)).toBe(false);
    // Negative polarity: processing, failed, no-version, draft, scheduled, expired and retracted documents.
    for (const name of [
      'docProcessing',
      'docFailed',
      'docNoVersion',
      'docDraftCurrent',
      'docScheduled',
      'docExpired',
      'docRetracted',
    ] as const) {
      for (const [who, set] of visible)
        expect(set.has(acme.documentNames[name]!), `${who} ${name}`).toBe(false);
    }
    // The second org has the flag off: every document is invisible to everyone there.
    const off = await allVisibleDocs(globex);
    for (const [who, set] of off) expect(set.size, `globex ${who}`).toBe(0);
    for (const [, userId] of Object.entries(fixture.users)) {
      for (const id of docIds(globex)) expect(readerVisible(globex, userId, id, NOW)).toBe(false);
    }
  });

  it('documents: the org flag and the kill switch hide every document on the next query and advance the org epoch', async () => {
    const [acme] = fixture.orgs;
    const epoch = async () => {
      await admin.query(`SELECT set_config('app.org_id', $1, false)`, [acme.orgId]);
      const r = await admin.query<{ e: string }>(
        'SELECT current_org_content_epoch($1)::text AS e',
        [acme.orgId],
      );
      return Number(r.rows[0]!.e);
    };
    const before = await allVisibleDocs(acme);
    expect([...before.values()].reduce((n, s) => n + s.size, 0)).toBeGreaterThan(0);

    let e0 = await epoch();
    await admin.query(
      `UPDATE org SET settings = settings || '{"documents_enabled": false}' WHERE id = $1`,
      [acme.orgId],
    );
    let e1 = await epoch();
    expect(e1).toBeGreaterThan(e0);
    const offSnap = { ...acme, documentsEnabled: false };
    for (const [name, userId] of Object.entries(fixture.users)) {
      const got = await sqlReaderVisibleApp(acme, userId);
      for (const id of docIds(acme)) {
        expect(got.has(id)).toBe(false);
        expect(readerVisible(offSnap, userId, id, NOW)).toBe(false);
      }
      // Clips are unaffected by the flag.
      for (const c of acme.content.filter((x) => x.kind === 'clip'))
        expect(got.has(c.id), `${name} clip`).toBe(readerVisible(acme, userId, c.id, NOW));
    }
    // An org with no documents_enabled key behaves as off.
    await admin.query(`UPDATE org SET settings = settings - 'documents_enabled' WHERE id = $1`, [
      acme.orgId,
    ]);
    expect([...(await allVisibleDocs(acme)).values()].reduce((n, s) => n + s.size, 0)).toBe(0);
    await admin.query(
      `UPDATE org SET settings = settings || '{"documents_enabled": true}' WHERE id = $1`,
      [acme.orgId],
    );
    expect(
      [...(await allVisibleDocs(acme)).values()].reduce((n, s) => n + s.size, 0),
    ).toBeGreaterThan(0);

    // Kill switch: overrides the org flag, advances the epoch of every org, and the reference carries it too.
    e0 = await epoch();
    await admin.query('SELECT platform_documents_kill_switch_set(true)');
    e1 = await epoch();
    expect(e1).toBeGreaterThan(e0);
    const killSnap = { ...acme, documentsKillSwitch: true };
    for (const [, userId] of Object.entries(fixture.users)) {
      const got = await sqlReaderVisibleApp(acme, userId);
      for (const id of docIds(acme)) {
        expect(got.has(id)).toBe(false);
        expect(readerVisible(killSnap, userId, id, NOW)).toBe(false);
      }
    }
    await admin.query('SELECT platform_documents_kill_switch_set(false)');
    expect(
      [...(await allVisibleDocs(acme)).values()].reduce((n, s) => n + s.size, 0),
    ).toBeGreaterThan(0);
  });

  it('control: a predicate without the document gate disagrees with the reference (leaks processing documents)', async () => {
    const [acme] = fixture.orgs;
    const sql = readerVisibleSql({ org: '$1', user: '$2', now: NOW_SQL });
    const gate = documentGateSql({ org: '$1', user: '$2', now: NOW_SQL });
    expect(sql).toContain(gate);
    const broken = sql.replace(gate, 'TRUE');
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [acme.orgId]);
    const r = await admin.query<{ id: string }>(`SELECT c.id FROM content c WHERE ${broken}`, [
      acme.orgId,
      fixture.users.member,
    ]);
    const got = new Set(r.rows.map((x) => x.id));
    expect(got.has(acme.documentNames.docProcessing!)).toBe(true); // the leak the real gate prevents
    const disagreements = acme.content.filter(
      (c) => got.has(c.id) !== readerVisible(acme, fixture.users.member!, c.id, NOW),
    );
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it('the gate is an uncorrelated InitPlan: platform_documents_enabled is evaluated once per query, not per row', async () => {
    const [acme] = fixture.orgs;
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [acme.orgId]);
    const plan = await admin.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (VERBOSE, COSTS OFF) SELECT c.id FROM content c WHERE ${readerVisibleSql({ org: '$1', user: '$2' })}`,
      [acme.orgId, fixture.users.member],
    );
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toMatch(/InitPlan/);
    expect(text.match(/platform_documents_enabled/g)?.length).toBe(1);
  });

  it('parity: platform_audience_of_content equals the reference predicate for every content (real clock)', async () => {
    const now = new Date();
    let nonEmpty = 0;
    let docNonEmpty = 0;
    for (const org of fixture.orgs) {
      for (const c of org.content) {
        const r = await admin.query<{ user_id: string }>(
          'SELECT user_id FROM platform_audience_of_content($1, $2)',
          [org.orgId, c.id],
        );
        const got = new Set(r.rows.map((x) => x.user_id));
        const want = new Set(
          Object.values(fixture.users).filter((u) => readerVisible(org, u, c.id, now)),
        );
        expect([...got].sort(), `${org.slug} ${c.kind} ${c.id}`).toEqual([...want].sort());
        if (got.size > 0) nonEmpty += 1;
        if (got.size > 0 && c.kind === 'document') docNonEmpty += 1;
      }
    }
    expect(nonEmpty).toBeGreaterThan(5);
    expect(docNonEmpty).toBeGreaterThan(0);
  });

  it('parity: platform_digest_items shows a title exactly when the reference says the content is reader-visible', async () => {
    const now = new Date();
    let titled = 0;
    let titledDocs = 0;
    for (const org of fixture.orgs) {
      for (const [, userId] of Object.entries(fixture.users)) {
        const ids: string[] = [];
        const byNotification = new Map<string, string>();
        for (const c of org.content) {
          const n = await admin.query<{ id: string }>(
            `INSERT INTO notification (org_id, user_id, kind, reason, content_id, dedupe_key)
             VALUES ($1, $2, 'content.published', 'audience', $3, $4) RETURNING id`,
            [org.orgId, userId, c.id, `parity:${c.id}:${Math.random()}`],
          );
          ids.push(n.rows[0]!.id);
          byNotification.set(n.rows[0]!.id, c.id);
        }
        const r = await admin.query<{ items: Array<{ id: string; title: string | null }> }>(
          'SELECT platform_digest_items($1, $2, $3::uuid[]) AS items',
          [org.orgId, userId, ids],
        );
        expect(r.rows[0]!.items.length).toBe(org.content.length);
        for (const item of r.rows[0]!.items) {
          const cid = byNotification.get(item.id)!;
          const visible = readerVisible(org, userId, cid, now);
          expect(item.title !== null, `${org.slug} ${userId} ${cid}`).toBe(visible);
          if (visible) titled += 1;
          if (visible && org.documentNames && docIds(org).has(cid)) titledDocs += 1;
        }
      }
    }
    expect(titled).toBeGreaterThan(20);
    expect(titledDocs).toBeGreaterThan(0);
  });

  it('platform_viewers_of_version: no viewer rows for a processing, failed or flag-off document; clips unchanged', async () => {
    const [acme, globex] = fixture.orgs;
    const viewers = async (org: FixtureOrg, contentId: string): Promise<number> => {
      const v = await admin.query<{ id: string }>(
        'SELECT current_version_id AS id FROM content WHERE org_id = $1 AND id = $2',
        [org.orgId, contentId],
      );
      const versionId = v.rows[0]!.id;
      await admin.query(
        `INSERT INTO user_content_state (org_id, user_id, content_id, last_version_id, title_snapshot)
         VALUES ($1, $2, $3, $4, 't') ON CONFLICT (org_id, user_id, content_id) DO UPDATE SET last_version_id = EXCLUDED.last_version_id`,
        [org.orgId, fixture.users.member, contentId, versionId],
      );
      const r = await admin.query('SELECT user_id FROM platform_viewers_of_version($1, $2)', [
        org.orgId,
        versionId,
      ]);
      return r.rowCount ?? 0;
    };
    expect(await viewers(acme, acme.documentNames.docCompany!)).toBe(1);
    expect(await viewers(acme, acme.documentNames.docProcessing!)).toBe(0);
    expect(await viewers(acme, acme.documentNames.docFailed!)).toBe(0);
    expect(await viewers(globex, globex.documentNames.docCompany!)).toBe(0); // flag off in globex
    expect(await viewers(acme, acme.contentNames.companyPublished)).toBe(1); // a clip is unaffected
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
