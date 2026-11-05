// SPDX-License-Identifier: AGPL-3.0-only
// NEG-3 (matrix with both polarities), NEG-5/NEG-6 (replace, retract, snapshot timing with a blocking fake),
// AC-5 (fake clock crossing expires_at and publish_at inside one cache bucket), the permitted-id cache contract,
// flag and kill-switch behaviour, NEG-7/NEG-8/NEG-10, loader failure and fallback behaviour.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantClient } from '@our-stream/db';
import { FixedWindowLimiter } from './lib/limits.js';
import { EmbedRefusedError } from './lib/retrieval/embedder.js';
import { LEAK_CHECK_FAILED, readCounter } from './lib/retrieval/metrics.js';
import { bucketOf, PermittedIdCache } from './lib/retrieval/permitted-cache.js';
import { TrySemaphore } from './lib/retrieval/semaphore.js';
import { loadScopedSnapshot } from './lib/retrieval/reference-check.js';
import type { RetrievalOptions } from './routes/retrieval.js';
import {
  addMember,
  buildRetrievalApp,
  chunkIdsOfVersion,
  createWorld,
  dbReady,
  embedOrg,
  engineInput,
  FakeEmbedder,
  insertGroup,
  insertOrg,
  insertTuples,
  insertUser,
  lifecycleCreate,
  lifecyclePublish,
  lifecycleRetract,
  lifecycleVersion,
  query,
  runEngineApp,
  seedContent,
  sessionFor,
  type World,
} from './retrieval-test-support.js';

const bigLimiter = () => new FixedWindowLimiter({ max: 1_000_000, windowMs: 60_000 });
const orgWide = (orgId: string) => [
  { subjectType: 'org' as const, subjectId: orgId, subjectRelation: 'member' },
];
const idsOf = (r: Awaited<ReturnType<typeof query>>) => (r.body.items ?? []).map((i) => i.chunkId);

describe.skipIf(!dbReady)('retrieval: negatives, timing and cache contract', () => {
  let w: World;
  let app: FastifyInstance;
  const embedder = new FakeEmbedder();
  const cache = new PermittedIdCache();
  const logs: string[] = [];
  const clock = () => new Date();
  let opts: RetrievalOptions;

  // org A with a control member; org B for the cross-org case
  let orgA = '';
  let orgB = '';
  let contributor = '';
  let control = '';
  let owner = '';

  const tokenCache = new Map<string, string>();
  const token = async (user: string, org: string | null) => {
    const k = `${user}:${org}`;
    if (!tokenCache.has(k)) tokenCache.set(k, await sessionFor(w, user, org));
    return tokenCache.get(k)!;
  };
  const ask = async (user: string, org: string, q: string, k = 50) =>
    query(app, await token(user, org), q, k);

  beforeAll(async () => {
    w = await createWorld('rtneg');
    orgA = await insertOrg(w, `rtneg-a-${randomUUID().slice(0, 6)}`, { documents_enabled: true });
    orgB = await insertOrg(w, `rtneg-b-${randomUUID().slice(0, 6)}`, { documents_enabled: true });
    owner = await insertUser(w, 'owner');
    contributor = await insertUser(w, 'contributor');
    control = await insertUser(w, 'control');
    await addMember(w, orgA, owner, 'owner');
    await addMember(w, orgA, contributor, 'contributor');
    await addMember(w, orgA, control, 'member');
    await addMember(w, orgB, owner, 'owner');
    opts = {
      embedder,
      cache,
      limiter: bigLimiter(),
      now: () => clock(),
    };
    app = await buildRetrievalApp(w, opts, { write: (l) => logs.push(l) });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await w?.close();
  });

  async function seedDoc(
    org: string,
    token: string,
    over: Partial<Parameters<typeof seedContent>[1]> = {},
  ) {
    const s = await seedContent(w, {
      orgId: org,
      kind: 'document',
      ownerId: contributor,
      chunks: [`${token} alpha paragraph`, `${token} beta paragraph`],
      audience: orgWide(org),
      ...over,
    });
    await embedOrg(w, org);
    return s;
  }

  describe('NEG-3: zero chunks for each unpermitted viewer, non-zero once permitted (both polarities)', () => {
    it('same account in another org: zero from org B and 403 for org A; non-zero after joining A', async () => {
      const x = await insertUser(w, 'xorg');
      await addMember(w, orgB, x, 'member');
      const doc = await seedDoc(orgA, 'negtokenxorg');
      cache.clear();
      const fromB = await ask(x, orgB, 'negtokenxorg');
      expect(fromB.status).toBe(200);
      expect(idsOf(fromB).filter((id) => doc.chunkIds.includes(id))).toEqual([]);
      const eng = await runEngineApp(w, engineInput(orgB, x, 'negtokenxorg', { k: 50 }));
      expect(eng.items.filter((i) => doc.chunkIds.includes(i.chunkId))).toEqual([]);
      const asA = await ask(x, orgA, 'negtokenxorg');
      expect(asA.status).toBe(403);
      expect(asA.body.items).toBeUndefined();
      await addMember(w, orgA, x, 'member');
      cache.clear();
      const after = await ask(x, orgA, 'negtokenxorg');
      expect(idsOf(after).filter((id) => doc.chunkIds.includes(id)).length).toBe(2);
    });

    it('removed member: 403 at the guard, zero from the SQL layer; restored member is served', async () => {
      const u = await insertUser(w, 'removed');
      await addMember(w, orgA, u, 'member');
      const doc = await seedDoc(orgA, 'negtokenremoved');
      cache.clear();
      expect(
        idsOf(await ask(u, orgA, 'negtokenremoved')).filter((i) => doc.chunkIds.includes(i)).length,
      ).toBe(2);
      await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgA]);
      await w.admin.query('DELETE FROM org_membership WHERE org_id = $1 AND user_id = $2', [
        orgA,
        u,
      ]);
      cache.clear();
      const r = await ask(u, orgA, 'negtokenremoved');
      expect([401, 403]).toContain(r.status); // the membership trigger revokes the user's sessions
      expect(r.body.items).toBeUndefined();
      const eng = await runEngineApp(w, engineInput(orgA, u, 'negtokenremoved', { k: 50 }));
      expect(eng.items).toEqual([]);
      await addMember(w, orgA, u, 'member');
      await w.admin.query('UPDATE platform.session SET revoked_at = NULL WHERE user_id = $1', [u]);
      cache.clear();
      expect(
        idsOf(await ask(u, orgA, 'negtokenremoved')).filter((i) => doc.chunkIds.includes(i)).length,
      ).toBe(2);
    });

    it('deactivated user with a live session: 403 and zero from the SQL layer; reactivated is served', async () => {
      const u = await insertUser(w, 'deact');
      await addMember(w, orgA, u, 'member');
      const doc = await seedDoc(orgA, 'negtokendeact');
      const live = await token(u, orgA); // session created while active
      cache.clear();
      expect(
        idsOf(await query(app, live, 'negtokendeact', 50)).filter((i) => doc.chunkIds.includes(i))
          .length,
      ).toBe(2);
      await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgA]);
      await w.admin.query(
        `UPDATE org_membership SET status = 'deactivated' WHERE org_id = $1 AND user_id = $2`,
        [orgA, u],
      );
      const revoked = await query(app, live, 'negtokendeact', 50);
      expect([401, 403]).toContain(revoked.status); // deactivation revokes sessions...
      expect(revoked.body.items).toBeUndefined();
      // ...and even if a session survived (revocation undone here), the guard refuses the deactivated member
      await w.admin.query('UPDATE platform.session SET revoked_at = NULL WHERE user_id = $1', [u]);
      const r = await query(app, live, 'negtokendeact', 50);
      expect(r.status).toBe(403);
      expect(r.body.items).toBeUndefined();
      expect(
        (await runEngineApp(w, engineInput(orgA, u, 'negtokendeact', { k: 50 }))).items,
      ).toEqual([]);
      await w.admin.query(
        `UPDATE org_membership SET status = 'active' WHERE org_id = $1 AND user_id = $2`,
        [orgA, u],
      );
      await w.admin.query('UPDATE platform.session SET revoked_at = NULL WHERE user_id = $1', [u]);
      cache.clear();
      expect(
        idsOf(await query(app, live, 'negtokendeact', 50)).filter((i) => doc.chunkIds.includes(i))
          .length,
      ).toBe(2);
    });

    const stateCases: Array<{
      name: string;
      deny: Partial<Parameters<typeof seedContent>[1]>;
      allow: string;
    }> = [
      {
        name: 'draft',
        deny: { state: 'draft', publishAt: null },
        allow: `UPDATE content SET state = 'published', publish_at = now() - interval '1 hour' WHERE org_id = $1 AND id = $2`,
      },
      {
        name: 'notyetlive',
        deny: { publishAt: new Date(Date.now() + 3_600_000) },
        allow: `UPDATE content SET publish_at = now() - interval '1 hour' WHERE org_id = $1 AND id = $2`,
      },
      {
        name: 'expired',
        deny: { expiresAt: new Date(Date.now() - 60_000) },
        allow: `UPDATE content SET expires_at = NULL WHERE org_id = $1 AND id = $2`,
      },
    ];
    for (const c of stateCases) {
      it(`${c.name} content: zero for the viewer, non-zero for the same viewer once the state permits`, async () => {
        const doc = await seedDoc(orgA, `negtoken${c.name}`, c.deny);
        cache.clear();
        const denied = await ask(control, orgA, `negtoken${c.name}`);
        expect(denied.status).toBe(200);
        expect(idsOf(denied).filter((i) => doc.chunkIds.includes(i))).toEqual([]);
        const eng = await runEngineApp(
          w,
          engineInput(orgA, control, `negtoken${c.name}`, { k: 50 }),
        );
        expect(eng.items.filter((i) => doc.chunkIds.includes(i.chunkId))).toEqual([]);
        await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgA]);
        await w.admin.query(c.allow, [orgA, doc.contentId]);
        cache.clear();
        const allowed = await ask(control, orgA, `negtoken${c.name}`);
        expect(idsOf(allowed).filter((i) => doc.chunkIds.includes(i)).length).toBe(2);
      });
    }
  });

  describe('NEG-5 / NEG-6 / AC-5: replacement, retraction and snapshot timing', () => {
    const lorg = () => ({ orgId: orgA, contributor });

    it('replace: before the switch commit the old version is current, after it only the new one is reachable; retract removes everything', async () => {
      const id = await lifecycleCreate(w, lorg(), 'replace me');
      const v1 = await lifecycleVersion(w, lorg(), id, [
        { text: 'replaceable oldtext zeta' },
        { text: 'replaceable oldtext eta' },
      ]);
      expect(v1.verdict).toBe('ok');
      await lifecyclePublish(w, lorg(), id);
      await embedOrg(w, orgA);
      const old = await chunkIdsOfVersion(w, orgA, v1.versionId);
      cache.clear();
      const r1 = await ask(control, orgA, 'replaceable oldtext');
      expect(idsOf(r1).filter((c) => old.includes(c)).length).toBe(2);
      // a replacement is uploaded and claimed but NOT finished: the old version stays current by design
      const v2 = await w.admin.query<{ id: string }>(
        `INSERT INTO content_version (org_id, content_id, status, original_key, original_name, original_size, mime_type, processing_step)
         VALUES ($1, $2, 'uploaded', 'k2', 'g.pdf', 10, 'application/pdf', 'awaiting_upload') RETURNING id`,
        [orgA, id],
      );
      await withTenant(w.app, { orgId: orgA, userId: contributor }, async (c) => {
        await c.query('SELECT document_upload_complete($1, $2)', [id, v2.rows[0]!.id]);
      });
      const claim = await w.platform.query<{ a: string }>(
        'SELECT platform_document_claim($1, $2) AS a',
        [orgA, v2.rows[0]!.id],
      );
      cache.clear();
      expect(
        idsOf(await ask(control, orgA, 'replaceable oldtext')).filter((c) => old.includes(c))
          .length,
      ).toBe(2);
      // the switch commits
      const fin = await w.platform.query<{ r: string }>(
        'SELECT platform_document_finish($1, $2, $3, $4::jsonb) AS r',
        [
          orgA,
          v2.rows[0]!.id,
          claim.rows[0]!.a,
          JSON.stringify([
            { locator: { kind: 'pdf', page: 1 }, text: 'replaceable newtext theta', lang: 'en' },
          ]),
        ],
      );
      expect(fin.rows[0]!.r).toBe('ok');
      const fresh = await chunkIdsOfVersion(w, orgA, v2.rows[0]!.id);
      // the new chunk has no vector yet: it takes part in the keyword leg only, and is found that way
      const afterSwitch = await ask(control, orgA, 'replaceable newtext');
      expect(idsOf(afterSwitch)).toContain(fresh[0]);
      expect(idsOf(afterSwitch).filter((c) => old.includes(c))).toEqual([]);
      const wide = await ask(control, orgA, 'replaceable');
      expect(idsOf(wide).filter((c) => old.includes(c))).toEqual([]);
      // broken variant: SQL that serves chunks of ANY version of a visible item is caught by the independent
      // reference (it compares the chunk's version with the content's current version): fail closed.
      const stale = await buildRetrievalApp(w, {
        ...opts,
        variant: 'wrong_version',
        cache: new PermittedIdCache(),
      });
      try {
        const before = readCounter(LEAK_CHECK_FAILED);
        const bad = await query(stale, await token(control, orgA), 'replaceable oldtext', 50);
        expect(bad.status).toBe(500);
        expect(bad.body.items).toBeUndefined();
        expect(readCounter(LEAK_CHECK_FAILED)).toBe(before + 1);
      } finally {
        await stale.close();
      }
      await embedOrg(w, orgA);
      // retract: the next request returns nothing of it (end to end retrieve, retract, retrieve)
      expect(idsOf(await ask(control, orgA, 'replaceable newtext'))).toContain(fresh[0]);
      await lifecycleRetract(w, lorg(), id);
      const gone = await ask(control, orgA, 'replaceable newtext');
      expect(idsOf(gone).filter((c) => [...old, ...fresh].includes(c))).toEqual([]);
    });

    it('NEG-6: a request whose snapshot began before the retraction may return it once; every later request never does; the pre-T result is not cached', async () => {
      const id = await lifecycleCreate(w, lorg(), 'snapshot timing');
      const v = await lifecycleVersion(w, lorg(), id, [
        { text: 'snaptiming gamma' },
        { text: 'snaptiming delta' },
      ]);
      await lifecyclePublish(w, lorg(), id);
      await embedOrg(w, orgA);
      const mine = await chunkIdsOfVersion(w, orgA, v.versionId);
      const gate = { reached: null as null | (() => void), release: null as null | (() => void) };
      const reached = new Promise<void>((r) => (gate.reached = r));
      const released = new Promise<void>((r) => (gate.release = r));
      const blocked = await buildRetrievalApp(w, {
        ...opts,
        cache: new PermittedIdCache(),
        tenantHooks: {
          onPhase: async (phase) => {
            if (phase === 'snapshot-started') {
              gate.reached!();
              await released;
            }
          },
        },
      });
      try {
        const tabA = query(blocked, await token(control, orgA), 'snaptiming', 50);
        await reached; // snapshot taken; request A is parked
        // two tabs: a second request on the same blocked app would also park, so use the normal app for tab B after commit
        await lifecycleRetract(w, lorg(), id); // T commits
        gate.release!();
        const a = await tabA;
        expect(a.status).toBe(200);
        expect(idsOf(a).filter((c) => mine.includes(c)).length).toBe(2); // pre-T snapshot may return it once
        const after = await ask(control, orgA, 'snaptiming');
        expect(idsOf(after).filter((c) => mine.includes(c))).toEqual([]); // any request starting after: never
        const retry = await query(blocked, await token(control, orgA), 'snaptiming', 50);
        expect(idsOf(retry).filter((c) => mine.includes(c))).toEqual([]); // a retry behaves the same
      } finally {
        await blocked.close();
      }
    });

    it('a revocation committed between the epoch pre-read and the first snapshot statement is never returned, and the pair is not cached', async () => {
      const id = await lifecycleCreate(w, lorg(), 'between reads');
      const v = await lifecycleVersion(w, lorg(), id, [{ text: 'betweenreads epsilon' }]);
      await lifecyclePublish(w, lorg(), id);
      await embedOrg(w, orgA);
      const mine = await chunkIdsOfVersion(w, orgA, v.versionId);
      const local = new PermittedIdCache();
      let fired = false;
      const hooked = await buildRetrievalApp(w, {
        ...opts,
        cache: local,
        tenantHooks: {
          onPhase: async (phase) => {
            if (phase === 'pre-read-done' && !fired) {
              fired = true;
              await lifecycleRetract(w, lorg(), id);
            }
          },
        },
      });
      try {
        const r = await query(hooked, await token(control, orgA), 'betweenreads', 50);
        expect(fired).toBe(true);
        expect(idsOf(r).filter((c) => mine.includes(c))).toEqual([]); // the snapshot began after T
        expect(local.size).toBe(0); // before/after epochs differ: never cached
      } finally {
        await hooked.close();
      }
    });

    it('a writer holding its change open after nextval: the reader may cache a pre-commit set under the new epoch, and no stale result is returned after the commit', async () => {
      const id = await lifecycleCreate(w, lorg(), 'open writer');
      const v = await lifecycleVersion(w, lorg(), id, [
        { text: 'openwriter zeta' },
        { text: 'openwriter eta' },
      ]);
      await lifecyclePublish(w, lorg(), id);
      await embedOrg(w, orgA);
      const mine = await chunkIdsOfVersion(w, orgA, v.versionId);
      const local = new PermittedIdCache();
      const localApp = await buildRetrievalApp(w, { ...opts, cache: local });
      const writer = await w.app.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
          [orgA, contributor],
        );
        await writer.query('SELECT content_retract($1)', [id]); // nextval happens now; not committed
        const during = await query(localApp, await token(control, orgA), 'openwriter', 50);
        expect(idsOf(during).filter((c) => mine.includes(c)).length).toBe(2); // the reader's snapshot predates the commit
        expect(local.size).toBe(1); // hazard realised: the epoch pair is stable, so the set was cached under the new epoch
        await writer.query('COMMIT');
        const hitsBefore = local.hits;
        const after = await query(localApp, await token(control, orgA), 'openwriter', 50);
        expect(local.hits).toBe(hitsBefore + 1); // the stale entry WAS used as candidates
        expect(idsOf(after).filter((c) => mine.includes(c))).toEqual([]); // ...and could only narrow
      } finally {
        writer.release();
        await localApp.close();
      }
    });

    it('AC-5 fake clock: expires_at and publish_at crossed inside one 30 s bucket (removal exact, addition lags at most one bucket)', async () => {
      const base = Math.floor(Date.now() / 30_000) * 30_000 + 30_000 * 1000; // a bucket start in the future, away from real time
      const at = (offsetMs: number) => new Date(base + offsetMs);
      const expiring = await seedContent(w, {
        orgId: orgA,
        kind: 'document',
        ownerId: contributor,
        publishAt: at(-3_600_000),
        expiresAt: at(10_000),
        chunks: ['fakeclock expiring one', 'fakeclock expiring two'],
        audience: orgWide(orgA),
      });
      const scheduled = await seedContent(w, {
        orgId: orgA,
        kind: 'document',
        ownerId: contributor,
        publishAt: at(10_000),
        chunks: ['fakeclock scheduled one', 'fakeclock scheduled two'],
        audience: orgWide(orgA),
      });
      await embedOrg(w, orgA);
      const local = new PermittedIdCache();
      let t = at(1_000);
      const clocked = await buildRetrievalApp(w, { ...opts, cache: local, now: () => t });
      try {
        const tk = await token(control, orgA);
        const ids = (r: Awaited<ReturnType<typeof query>>, s: { chunkIds: string[] }) =>
          idsOf(r).filter((c) => s.chunkIds.includes(c)).length;
        const r1 = await query(clocked, tk, 'fakeclock', 50);
        expect(ids(r1, expiring)).toBe(2);
        expect(ids(r1, scheduled)).toBe(0);
        expect(local.size).toBe(1);
        expect(bucketOf(at(1_000).getTime())).toBe(bucketOf(at(15_000).getTime()));
        t = at(15_000); // both crossings happened, same bucket
        const hits = local.hits;
        const r2 = await query(clocked, tk, 'fakeclock', 50);
        expect(local.hits).toBe(hits + 1); // served from the cached set
        expect(ids(r2, expiring)).toBe(0); // removal is exact: the predicate runs at the captured now
        expect(ids(r2, scheduled)).toBe(0); // addition lags: the cached set predates publish_at
        t = at(31_000); // next bucket
        const r3 = await query(clocked, tk, 'fakeclock', 50);
        expect(ids(r3, scheduled)).toBe(2);
        expect(ids(r3, expiring)).toBe(0);
      } finally {
        await clocked.close();
      }
    });

    it('a poisoned cache entry (ids the user may not see) adds nothing: the cache only narrows', async () => {
      const secret = await seedContent(w, {
        orgId: orgA,
        kind: 'document',
        ownerId: contributor,
        state: 'draft',
        publishAt: null,
        chunks: ['poisoncheck draft secret'],
        audience: orgWide(orgA),
      });
      await embedOrg(w, orgA);
      const local = new PermittedIdCache();
      const localApp = await buildRetrievalApp(w, { ...opts, cache: local });
      try {
        const ep = await w.admin.query<{ a: string }>(
          `SELECT authz_epoch::text AS a FROM org_membership WHERE org_id = $1 AND user_id = $2`,
          [orgA, control],
        );
        const e = await withTenant(
          w.app,
          { orgId: orgA, userId: control },
          async (c) =>
            (
              await c.query<{ e: string }>('SELECT current_org_content_epoch($1)::text AS e', [
                orgA,
              ])
            ).rows[0]!.e,
        );
        local.put(
          {
            orgId: orgA,
            userId: control,
            authzEpoch: Number(ep.rows[0]!.a),
            orgContentEpoch: Number(e),
            bucket: bucketOf(Date.now()),
          },
          [secret.contentId],
        );
        const r = await query(localApp, await token(control, orgA), 'poisoncheck', 50);
        expect(local.hits).toBe(1);
        expect(r.status).toBe(200);
        expect(idsOf(r)).toEqual([]);
      } finally {
        await localApp.close();
      }
    });
  });

  describe('flag and kill switch (NEG-11 for retrieval)', () => {
    it('flag off: documents vanish, clips stay; an absent key is off; flag on restores; toggling inside one bucket takes effect at once', async () => {
      const o = await insertOrg(w, `rtneg-flag-${randomUUID().slice(0, 6)}`, {
        documents_enabled: true,
      });
      const c = await insertUser(w, 'flagcontrol');
      await addMember(w, o, c, 'member');
      const doc = await seedContent(w, {
        orgId: o,
        kind: 'document',
        ownerId: c,
        chunks: ['flagmatrix doc one'],
        audience: orgWide(o),
      });
      const clip = await seedContent(w, {
        orgId: o,
        kind: 'clip',
        ownerId: c,
        chunks: ['flagmatrix clip one'],
        audience: orgWide(o),
      });
      await embedOrg(w, o);
      cache.clear();
      const set = async (s: Record<string, unknown>) => {
        await w.admin.query(`SELECT set_config('app.org_id', $1, false)`, [o]);
        await w.admin.query('UPDATE org SET settings = $2::jsonb WHERE id = $1', [
          o,
          JSON.stringify(s),
        ]);
      };
      const got = async () => idsOf(await ask(c, o, 'flagmatrix'));
      expect(await got()).toEqual(expect.arrayContaining([...doc.chunkIds, ...clip.chunkIds]));
      await set({ documents_enabled: false }); // inside the same cache bucket and fake-free clock
      let r = await got();
      expect(r).toEqual(expect.arrayContaining(clip.chunkIds));
      expect(r.filter((x) => doc.chunkIds.includes(x))).toEqual([]);
      await set({}); // absent key behaves as off
      r = await got();
      expect(r.filter((x) => doc.chunkIds.includes(x))).toEqual([]);
      expect(r).toEqual(expect.arrayContaining(clip.chunkIds));
      await set({ documents_enabled: 'yes' }); // anything but true is off
      expect((await got()).filter((x) => doc.chunkIds.includes(x))).toEqual([]);
      await set({ documents_enabled: true });
      expect(await got()).toEqual(expect.arrayContaining(doc.chunkIds));
      // a SQL predicate that forgot the document gate leaks a flag-off org's document; the reference (which
      // carries the flag) fails the request closed instead
      await set({ documents_enabled: false });
      const noGate = await buildRetrievalApp(w, {
        ...opts,
        variant: 'no_document_gate',
        cache: new PermittedIdCache(),
      });
      try {
        const before = readCounter(LEAK_CHECK_FAILED);
        const bad = await query(noGate, await token(c, o), 'flagmatrix', 50);
        expect(bad.status).toBe(500);
        expect(bad.body.items).toBeUndefined();
        expect(readCounter(LEAK_CHECK_FAILED)).toBe(before + 1);
      } finally {
        await noGate.close();
      }
    });

    it('deployment kill switch overrides the org flag, and releasing it restores', async () => {
      const doc = await seedDoc(orgA, 'killswitchtoken');
      cache.clear();
      expect(
        idsOf(await ask(control, orgA, 'killswitchtoken')).filter((i) => doc.chunkIds.includes(i))
          .length,
      ).toBe(2);
      await w.platform.query('SELECT platform_documents_kill_switch_set(true)');
      try {
        expect(
          idsOf(await ask(control, orgA, 'killswitchtoken')).filter((i) =>
            doc.chunkIds.includes(i),
          ),
        ).toEqual([]);
      } finally {
        await w.platform.query('SELECT platform_documents_kill_switch_set(false)');
      }
      expect(
        idsOf(await ask(control, orgA, 'killswitchtoken')).filter((i) => doc.chunkIds.includes(i))
          .length,
      ).toBe(2);
    });
  });

  describe('request contract', () => {
    it('NEG-8: a refused embed degrades to keyword_only with HTTP 200 and keyword hits; a timeout and an error degrade too', async () => {
      const doc = await seedDoc(orgA, 'refusedembed');
      const refuse = new FakeEmbedder();
      refuse.failWith = new EmbedRefusedError();
      const slow = new FakeEmbedder();
      slow.delayMs = 400;
      const boom = new FakeEmbedder();
      boom.failWith = new Error('upstream exploded with echo refusedembed');
      for (const [e, reason, ms] of [
        [refuse, 'embed_refused', 2000],
        [slow, 'embed_timeout', 50],
        [boom, 'embed_unavailable', 2000],
      ] as const) {
        const a = await buildRetrievalApp(w, {
          ...opts,
          embedder: e,
          embedTimeoutMs: ms,
          cache: new PermittedIdCache(),
        });
        try {
          const r = await query(a, await token(control, orgA), 'refusedembed', 50);
          expect(r.status).toBe(200);
          expect(r.body.retrievalMode).toBe('keyword_only');
          expect(r.body.degraded).toBe(reason);
          expect(idsOf(r).filter((i) => doc.chunkIds.includes(i)).length).toBe(2);
        } finally {
          await a.close();
        }
      }
      const noEmbedder = await buildRetrievalApp(w, {
        ...opts,
        embedder: null,
        cache: new PermittedIdCache(),
      });
      try {
        const r = await query(noEmbedder, await token(control, orgA), 'refusedembed', 50);
        expect(r.body.retrievalMode).toBe('keyword_only');
        expect(r.body.degraded).toBe('embed_unavailable');
      } finally {
        await noEmbedder.close();
      }
      const ok = await ask(control, orgA, 'refusedembed');
      expect(ok.body.retrievalMode).toBe('hybrid');
      expect(ok.body.degraded).toBeNull();
    });

    it('an embedder whose model differs from the active pin is not used (keyword_only, pin_mismatch)', async () => {
      const other = new FakeEmbedder();
      other.model = 'some-other-model';
      const a = await buildRetrievalApp(w, {
        ...opts,
        embedder: other,
        cache: new PermittedIdCache(),
      });
      try {
        const r = await query(a, await token(control, orgA), 'refusedembed', 50);
        expect(r.body.retrievalMode).toBe('keyword_only');
        expect(r.body.degraded).toBe('pin_mismatch');
      } finally {
        await a.close();
      }
    });

    it('NEG-7: NFC and NFD, zero-width variants, empty, unsupported-language and oversize queries cause no error and no leak', async () => {
      const doc = await seedDoc(orgA, 'caféunicodeprobe');
      cache.clear();
      const nfc = await ask(control, orgA, 'caféunicodeprobe');
      const nfd = await ask(control, orgA, 'caféunicodeprobe');
      const zw = await ask(control, orgA, 'café​unicodeprobe');
      for (const r of [nfc, nfd, zw]) {
        expect(r.status).toBe(200);
        expect(idsOf(r).filter((i) => doc.chunkIds.includes(i)).length).toBe(2);
      }
      for (const q of ['', '   ', '​​', '\u0000\u0001']) {
        const r = await ask(control, orgA, q);
        expect(r.status, JSON.stringify(q)).toBe(200);
        expect(r.body.items).toEqual([]);
      }
      const cjk = await ask(control, orgA, '日本語のクエリ');
      expect(cjk.status).toBe(200);
      const over = await ask(control, orgA, 'x'.repeat(2001));
      expect(over.status).toBe(400);
      expect((await ask(control, orgA, 'x'.repeat(2000))).status).toBe(200);
      const k51 = await ask(control, orgA, 'alpha', 51);
      expect(k51.status).toBe(400);
      const k0 = await ask(control, orgA, 'alpha', 0);
      expect(k0.status).toBe(400);
    });

    it('NEG-7: 60 per user per minute by default, then 429 with a stable body', async () => {
      const u = await insertUser(w, 'ratelimited');
      await addMember(w, orgA, u, 'member');
      const limited = await buildRetrievalApp(w, {
        embedder,
        cache: new PermittedIdCache(),
        now: () => clock(),
      });
      try {
        const tk = await token(u, orgA);
        for (let i = 0; i < 60; i += 1)
          expect((await query(limited, tk, 'alpha', 1)).status).toBe(200);
        const a = await query(limited, tk, 'alpha', 1);
        const b = await query(limited, tk, 'alpha', 1);
        expect(a.status).toBe(429);
        expect(b.status).toBe(429);
        const strip = (raw: string) => JSON.parse(raw).error as { code: string; message: string };
        expect(strip(a.raw).code).toBe('rate_limited');
        expect(strip(a.raw).message).toBe('too many requests');
        expect(strip(b.raw).message).toBe(strip(a.raw).message);
        // another user is not affected
        expect((await query(limited, await token(control, orgA), 'alpha', 1)).status).toBe(200);
      } finally {
        await limited.close();
      }
    });

    it('unauthenticated and org-less sessions are refused', async () => {
      const anon = await app.inject({
        method: 'POST',
        url: '/v1/retrieval/query',
        payload: { q: 'x' },
      });
      expect(anon.statusCode).toBe(401);
      const noOrg = await query(app, await token(control, null), 'x');
      expect(noOrg.status).toBe(403);
    });

    it('NEG-10: neither the query text nor chunk text reaches the logs, on success or on a failed request', async () => {
      const canaryQ = `canaryq${randomUUID().replace(/-/g, '')}`;
      const doc = await seedDoc(orgA, canaryQ);
      logs.length = 0;
      const ok = await ask(control, orgA, canaryQ);
      expect(idsOf(ok).filter((i) => doc.chunkIds.includes(i)).length).toBe(2);
      const broken = await buildRetrievalApp(
        w,
        { ...opts, variant: 'wrong_predicate', cache: new PermittedIdCache() },
        { write: (l) => logs.push(l) },
      );
      try {
        const bad = await query(broken, await token(control, orgA), canaryQ, 50);
        expect(bad.status).toBe(500);
        expect(bad.raw).not.toContain(canaryQ);
      } finally {
        await broken.close();
      }
      expect(logs.length).toBeGreaterThan(0); // the failed request did log
      expect(logs.join('\n')).not.toContain(canaryQ);
    });
  });

  describe('fail-closed post-check and bounded fallback', () => {
    it('loader failure: the request fails, nothing is returned, authz.leak_check_failed increments', async () => {
      const before = readCounter(LEAK_CHECK_FAILED);
      const a = await buildRetrievalApp(w, {
        ...opts,
        cache: new PermittedIdCache(),
        hooks: {
          loader: async () => {
            throw new Error('loader down');
          },
        },
      });
      try {
        const r = await query(a, await token(control, orgA), 'alpha', 50);
        expect(r.status).toBe(500);
        expect(r.body.items).toBeUndefined();
        expect(readCounter(LEAK_CHECK_FAILED)).toBe(before + 1);
      } finally {
        await a.close();
      }
    });

    it('nested groups: the scoped snapshot carries the closure and the reference agrees with SQL at depth 4', async () => {
      const o = await insertOrg(w, `rtneg-grp-${randomUUID().slice(0, 6)}`, {
        documents_enabled: true,
      });
      const u = await insertUser(w, 'nested');
      const owner2 = await insertUser(w, 'nestedowner');
      await addMember(w, o, u, 'member');
      await addMember(w, o, owner2, 'owner');
      const g = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      for (const id of g) await insertGroup(w, o, id);
      const t = (obj: string, subjType: 'user' | 'group', subj: string) => ({
        objectType: 'group' as const,
        objectId: obj,
        relation: 'member',
        subjectType: subjType,
        subjectId: subj,
        subjectRelation: '',
      });
      await insertTuples(w, o, [
        t(g[0]!, 'user', u),
        t(g[1]!, 'group', g[0]!),
        t(g[2]!, 'group', g[1]!),
        t(g[3]!, 'group', g[2]!),
      ]);
      const doc = await seedContent(w, {
        orgId: o,
        kind: 'document',
        ownerId: owner2,
        chunks: ['nestedgroups deep chunk'],
        audience: [{ subjectType: 'group', subjectId: g[3]!, subjectRelation: '' }],
      });
      await embedOrg(w, o);
      const snap = await withTenant(
        w.app,
        { orgId: o, userId: u },
        (c) => loadScopedSnapshot(c, o, u, [doc.contentId]),
        { isolation: 'REPEATABLE READ' },
      );
      expect(new Set(snap.groups.map((x) => x.id))).toEqual(new Set(g));
      const r = await runEngineApp(w, engineInput(o, u, 'nestedgroups', { k: 10 }));
      expect(r.items.map((i) => i.chunkId)).toEqual(doc.chunkIds);
    });

    async function smallOrgForFallback() {
      const o = await insertOrg(w, `rtneg-fb-${randomUUID().slice(0, 6)}`, {
        documents_enabled: true,
      });
      const u = await insertUser(w, 'fb');
      const own = await insertUser(w, 'fbowner');
      await addMember(w, o, u, 'member');
      await addMember(w, o, own, 'owner');
      const docs = [] as Awaited<ReturnType<typeof seedContent>>[];
      for (let i = 0; i < 3; i += 1)
        docs.push(
          await seedContent(w, {
            orgId: o,
            kind: 'document',
            ownerId: own,
            chunks: [`fallbackcase item ${i} first`, `fallbackcase item ${i} second`],
            audience: orgWide(o),
          }),
        );
      await embedOrg(w, o);
      return { o, u, docs, all: docs.flatMap((d) => d.chunkIds) };
    }

    it('exact-scan fallback runs when the approximate leg returns fewer than k rows, and keeps the snapshot', async () => {
      const { o, u, all } = await smallOrgForFallback();
      const r = await runEngineApp(w, engineInput(o, u, 'fallbackcase', { k: 10 }));
      expect(r.fallbackUsed).toBe(true);
      expect(r.retrievalMode).toBe('hybrid');
      expect(new Set(r.items.map((i) => i.chunkId))).toEqual(new Set(all));
    });

    it('fallback timeout: rolls back to the savepoint, response is keyword_only + flag, snapshot intact, HTTP 200', async () => {
      const { o, u, all } = await smallOrgForFallback();
      const a = await buildRetrievalApp(w, {
        ...opts,
        cache: new PermittedIdCache(),
        tuning: { fallbackTimeoutMs: 30 },
        hooks: {
          inFallback: async (c) => {
            await c.query('SELECT pg_sleep(0.5)');
          },
        },
      });
      try {
        const r = await query(a, await sessionFor(w, u, o), 'fallbackcase', 10);
        expect(r.status).toBe(200);
        expect(r.body.retrievalMode).toBe('keyword_only');
        expect(r.body.degraded).toBe('fallback_timeout');
        expect(idsOf(r).length).toBeGreaterThan(0); // keyword hits, hydrated in the same snapshot after the rollback
        for (const id of idsOf(r)) expect(all).toContain(id);
      } finally {
        await a.close();
      }
    });

    it('after a successful fallback the previous statement_timeout is restored: a loader slower than 200 ms succeeds (broken variant fails)', async () => {
      const { o, u } = await smallOrgForFallback();
      const slowLoader = {
        beforeLoader: async (c: TenantClient) => {
          await c.query('SELECT pg_sleep(0.4)');
        },
      };
      const good = await runEngineApp(
        w,
        engineInput(o, u, 'fallbackcase', { k: 10, hooks: slowLoader }),
      );
      expect(good.fallbackUsed).toBe(true);
      expect(good.items.length).toBeGreaterThan(0);
      await expect(
        runEngineApp(
          w,
          engineInput(o, u, 'fallbackcase', {
            k: 10,
            hooks: slowLoader,
            variant: 'no_timeout_restore',
          }),
        ),
      ).rejects.toThrow(/statement timeout/);
    });

    it('a full fallback semaphore degrades to keyword_only at once (no waiting)', async () => {
      const { o, u } = await smallOrgForFallback();
      const sem = new TrySemaphore(4);
      const held = [sem.tryAcquire(), sem.tryAcquire(), sem.tryAcquire(), sem.tryAcquire()];
      const t0 = Date.now();
      const r = await runEngineApp(w, engineInput(o, u, 'fallbackcase', { k: 10, semaphore: sem }));
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(r.retrievalMode).toBe('keyword_only');
      expect(r.degraded).toBe('fallback_busy');
      expect(r.items.length).toBeGreaterThan(0);
      held.forEach((h) => h!());
      expect(sem.active).toBe(0);
    });

    it('a permitted set above the row cap is not scanned exactly: keyword_only with fallback_cap', async () => {
      const { o, u } = await smallOrgForFallback();
      const r = await runEngineApp(
        w,
        engineInput(o, u, 'fallbackcase', { k: 10, tuning: { fallbackRowCap: 2 } }),
      );
      expect(r.retrievalMode).toBe('keyword_only');
      expect(r.degraded).toBe('fallback_cap');
      expect(r.items.length).toBeGreaterThan(0);
    });
  });

  it('keeps pg connections clean (no leaked tenant context after the suite)', async () => {
    const c = new pg.Client({ connectionString: w.appUrl });
    await c.connect();
    const r = await c.query(`SELECT current_setting('app.org_id', true) AS o`);
    expect(r.rows[0]!.o ?? '').toBe('');
    await c.end();
  });
});
