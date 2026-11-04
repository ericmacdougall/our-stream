// SPDX-License-Identifier: AGPL-3.0-only
// Auth flows through the real database: signup/login/logout, cookie vs bearer, CSRF, magic links
// (single use, expiry, replay control), invites, org switching, rate limiting and deactivation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { FakeMailer } from './lib/mailer.js';
import { sha256 } from './lib/tokens.js';
import { createHarness, integrationReady, type Harness, type Session } from './test-harness.js';

describe.skipIf(!integrationReady)('auth (integration)', () => {
  let h: Harness;
  let owner: Session;

  beforeAll(async () => {
    h = await createHarness('auth');
    owner = await h.signup('owner', 'acme');
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('signup sets an HttpOnly session cookie, returns Me with csrfToken and no token in the body', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: h.email('cookie'),
        password: 'correct-horse-battery-staple',
        displayName: 'Cookie',
        orgName: 'Cookie Org',
        orgSlug: `cookie-${h.suffix}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'os_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.secure).toBe(true); // NODE_ENV=test is not development
    const body = res.json();
    expect(body.org.slug).toBe(`cookie-${h.suffix}`);
    expect(body.org.role).toBe('owner');
    expect(body.memberships).toHaveLength(1);
    expect(typeof body.csrfToken).toBe('string');
    expect(body.sessionToken).toBeUndefined();
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('rejects a duplicate email and a duplicate org slug without creating partial state', async () => {
    const dupEmail = await h.call('POST', '/v1/auth/signup', null, {
      email: owner.email,
      password: 'correct-horse-battery-staple',
      displayName: 'Dup',
      orgName: 'Dup Org',
      orgSlug: `other-${h.suffix}`,
    });
    expect(dupEmail.status).toBe(409);
    expect((dupEmail.body as { error: { code: string } }).error.code).toBe('email_taken');
    const dupSlug = await h.call('POST', '/v1/auth/signup', null, {
      email: h.email('dupslug'),
      password: 'correct-horse-battery-staple',
      displayName: 'Dup',
      orgName: 'Dup Org',
      orgSlug: `acme-${h.suffix}`,
    });
    expect(dupSlug.status).toBe(409);
    expect((dupSlug.body as { error: { code: string } }).error.code).toBe('slug_taken');
    const acct = await h.admin.query(
      'SELECT 1 FROM platform.user_account WHERE email_normalized = $1',
      [h.email('dupslug')],
    );
    expect(acct.rowCount).toBe(0); // account insert rolled back with the failed org
  });

  it('login verifies the password, bearer transport returns a usable token, logout revokes', async () => {
    const bad = await h.call('POST', '/v1/auth/login', null, {
      email: owner.email,
      password: 'wrong-password-here',
    });
    expect(bad.status).toBe(401);
    const unknown = await h.call('POST', '/v1/auth/login', null, {
      email: h.email('nobody'),
      password: 'wrong-password-here',
    });
    expect(unknown.status).toBe(401);
    expect((unknown.body as { error: { code: string } }).error.code).toBe('invalid_credentials');

    const ok = await h.call(
      'POST',
      '/v1/auth/login',
      null,
      { email: owner.email, password: 'correct-horse-battery-staple' },
      { 'x-session-transport': 'bearer' },
    );
    expect(ok.status).toBe(200);
    const token = (ok.body as { sessionToken: string }).sessionToken;
    expect(typeof token).toBe('string');
    const me = await h.call('GET', '/v1/me', null, undefined, { authorization: `Bearer ${token}` });
    expect(me.status).toBe(200);
    expect((me.body as { user: { id: string } }).user.id).toBe(owner.userId);

    // Bearer mutations need no CSRF header.
    const out = await h.call('POST', '/v1/auth/logout', null, undefined, {
      authorization: `Bearer ${token}`,
    });
    expect(out.status).toBe(200);
    const after = await h.call('GET', '/v1/me', null, undefined, {
      authorization: `Bearer ${token}`,
    });
    expect(after.status).toBe(401);
  });

  it('GET /v1/me without credentials is 401; the session resolves membership from the database', async () => {
    expect((await h.call('GET', '/v1/me')).status).toBe(401);
    const me = await h.call('GET', '/v1/me', owner);
    expect(me.status).toBe(200);
    expect((me.body as { org: { role: string } }).org.role).toBe('owner');
  });

  it('cookie-authenticated mutations require the CSRF header or a trusted Origin', async () => {
    const body = { kind: 'department', slug: `csrf-${h.suffix}`, name: 'CSRF' };
    const noHeader = await h.app.inject({
      method: 'POST',
      url: '/v1/streams',
      cookies: { os_session: owner.cookie },
      payload: body,
    });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error.code).toBe('csrf');

    const evilOrigin = await h.app.inject({
      method: 'POST',
      url: '/v1/streams',
      cookies: { os_session: owner.cookie },
      headers: { origin: 'https://evil.example' },
      payload: body,
    });
    expect(evilOrigin.statusCode).toBe(403);

    const wrongToken = await h.app.inject({
      method: 'POST',
      url: '/v1/streams',
      cookies: { os_session: owner.cookie },
      headers: { 'x-csrf-token': 'nope' },
      payload: body,
    });
    expect(wrongToken.statusCode).toBe(403);

    const goodOrigin = await h.app.inject({
      method: 'POST',
      url: '/v1/streams',
      cookies: { os_session: owner.cookie },
      headers: { origin: 'http://localhost:3000' },
      payload: body,
    });
    expect(goodOrigin.statusCode).toBe(200);

    const withToken = await h.call('POST', '/v1/streams', owner, {
      ...body,
      slug: `csrf2-${h.suffix}`,
    });
    expect(withToken.status).toBe(200);
  });

  it('magic link: uniform response, single use, replay and expired links rejected', async () => {
    const before = h.mailer.sent.length;
    const unknown = await h.call('POST', '/v1/auth/magic-link', null, { email: h.email('ghost') });
    expect(unknown.status).toBe(200);
    expect(h.mailer.sent.length).toBe(before); // nothing sent, nothing revealed

    const known = await h.call('POST', '/v1/auth/magic-link', null, { email: owner.email });
    expect(known.status).toBe(200);
    const mail = h.mailer.lastTo(owner.email)!;
    expect(mail.text).toContain('http://localhost:3000/magic?token=');
    const token = decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]!);

    const first = await h.call('POST', '/v1/auth/magic-link/consume', null, { token });
    expect(first.status).toBe(200);
    expect((first.body as { user: { id: string } }).user.id).toBe(owner.userId);

    // Control: replaying the same link must fail.
    const replay = await h.call('POST', '/v1/auth/magic-link/consume', null, { token });
    expect(replay.status).toBe(401);
    expect((replay.body as { error: { code: string } }).error.code).toBe('invalid_token');

    // Expired link (created with a negative TTL) is refused.
    const expiredToken = 'expired-token-for-test-0123456789abcdef';
    await h.admin.query(
      `SELECT platform_magic_link_create($1, $2, 'login', NULL, interval '-1 minute')`,
      [owner.userId, sha256(expiredToken)],
    );
    const expired = await h.call('POST', '/v1/auth/magic-link/consume', null, {
      token: expiredToken,
    });
    expect(expired.status).toBe(401);
    expect(
      (await h.call('POST', '/v1/auth/magic-link/consume', null, { token: 'short' })).status,
    ).toBe(400);
  });

  it('invite: creates the membership on consume, lists members, refuses re-inviting an active member', async () => {
    const member = await h.invite(owner, 'invitee', 'member');
    expect(member.orgId).toBe(owner.orgId);
    const me = await h.call('GET', '/v1/me', member);
    expect((me.body as { org: { role: string } }).org.role).toBe('member');

    const members = await h.call('GET', '/v1/members', owner);
    expect(members.status).toBe(200);
    const list = members.body as Array<{ email: string; role: string }>;
    expect(list.map((m) => m.email)).toEqual(expect.arrayContaining([owner.email, member.email]));

    const again = await h.call('POST', '/v1/invites', owner, {
      email: member.email,
      role: 'member',
    });
    expect(again.status).toBe(409);
    // Non-admins cannot invite.
    const byMember = await h.call('POST', '/v1/invites', member, {
      email: h.email('x2'),
      role: 'member',
    });
    expect(byMember.status).toBe(403);
  });

  it('org switching requires an active membership in the target org', async () => {
    const otherOwner = await h.signup('other-owner', 'globex');
    const r = await h.call('POST', '/v1/invites', otherOwner, {
      email: owner.email,
      role: 'contributor',
    });
    expect(r.status).toBe(200);
    const joined = await h.consumeLastLink(owner.email);
    expect(joined.orgId).toBe(otherOwner.orgId);
    const memberships = (await h.call('GET', '/v1/me', joined)).body as {
      memberships: Array<{ orgId: string }>;
    };
    expect(memberships.memberships.map((m) => m.orgId).sort()).toEqual(
      [owner.orgId, otherOwner.orgId].sort(),
    );
    const back = await h.call('POST', '/v1/me/org', joined, { orgId: owner.orgId });
    expect(back.status).toBe(200);
    expect((back.body as { org: { id: string } }).org.id).toBe(owner.orgId);
    const nope = await h.call('POST', '/v1/me/org', joined, {
      orgId: '00000000-0000-4000-8000-000000000000',
    });
    expect(nope.status).toBe(409);
  });

  it('deactivating a member refuses their live session on the next /v1/sync and /v1/feed', async () => {
    const victim = await h.invite(owner, 'victim', 'member');
    expect((await h.call('GET', '/v1/sync', victim)).status).toBe(200);
    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [owner.orgId]);
    await h.admin.query(
      `UPDATE org_membership SET status = 'deactivated' WHERE org_id = $1 AND user_id = $2`,
      [owner.orgId, victim.userId],
    );
    // The membership trigger revokes the org's sessions synchronously, so the cookie is dead (401); a
    // session that survived would still be refused by the membership check (403).
    const sync = await h.call('GET', '/v1/sync', victim);
    expect([401, 403]).toContain(sync.status);
    const feed = await h.call('GET', '/v1/feed', victim);
    expect([401, 403]).toContain(feed.status);
  });

  it('signup cannot claim an invited address; the invitee sets a password from their own session (N2)', async () => {
    const addr = h.email('invited-pending');
    const inv = await h.call('POST', '/v1/invites', owner, { email: addr, role: 'member' });
    expect(inv.status).toBe(200);
    // Attacker who knows the address: no mailbox proof, must not obtain the account.
    const hijack = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: addr,
        password: 'attacker-chosen-password-1',
        displayName: 'Mallory',
        orgName: 'Mallory Org',
        orgSlug: `mallory-${h.suffix}`,
      },
    });
    expect(hijack.statusCode).toBe(409);
    expect(hijack.json().error.code).toBe('email_taken');
    const login = await h.call('POST', '/v1/auth/login', null, {
      email: addr,
      password: 'attacker-chosen-password-1',
    });
    expect(login.status).toBe(401);
    // The real invitee follows the emailed link, then chooses a password once.
    const invitee = await h.consumeLastLink(addr);
    const set = await h.call('POST', '/v1/auth/password', invitee, {
      password: 'invitee-chosen-password-1',
    });
    expect(set.status).toBe(200);
    const again = await h.call('POST', '/v1/auth/password', invitee, {
      password: 'another-password-attempt-2',
    });
    expect(again.status).toBe(409);
    const ok = await h.call('POST', '/v1/auth/login', null, {
      email: addr,
      password: 'invitee-chosen-password-1',
    });
    expect(ok.status).toBe(200);
    const anon = await h.call('POST', '/v1/auth/password', null, {
      password: 'nobody-here-123456',
    });
    expect(anon.status).toBe(401);
  });

  it('login and magic-link requests are budgeted per email address independently of the client address (N1/N6)', async () => {
    const mailer = new FakeMailer();
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: process.env['DATABASE_URL']!,
      AUTH_RATE_LIMIT_MAX: '10000',
      AUTH_EMAIL_RATE_LIMIT_MAX: '2',
    });
    const app = await buildApp({ config, pool: h.pool, version: 'test', mailer, store: h.store });
    try {
      const attempt = (i: number, email: string) =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          headers: { 'x-forwarded-for': `203.0.113.${i}` },
          payload: { email, password: 'wrong-password-here' },
        });
      expect((await attempt(1, owner.email)).statusCode).toBe(401);
      // A correct password is not charged: one failure so far, the owner still gets in.
      const good = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.9' },
        payload: { email: owner.email, password: 'correct-horse-battery-staple' },
      });
      expect(good.statusCode).toBe(200);
      expect((await attempt(2, owner.email)).statusCode).toBe(401);
      expect((await attempt(3, owner.email)).statusCode).toBe(429);
      // Another account's budget is untouched.
      expect((await attempt(4, h.email('someone-else'))).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('the application role cannot list memberships by arbitrary user id; only a live session token reads them (N7)', async () => {
    await expect(
      h.pool.query('SELECT * FROM platform_memberships_of($1)', [owner.userId]),
    ).rejects.toThrow(/permission denied|does not exist/); // revoked in 0005, dropped in 0006
    const bogus = await h.pool.query('SELECT * FROM platform_memberships_of_session($1)', [
      Buffer.alloc(32, 7),
    ]);
    expect(bogus.rowCount).toBe(0);
  });

  it('rotating a forged session cookie or bearer token does not evade the per-IP auth limit (N1)', async () => {
    const mailer = new FakeMailer();
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: process.env['DATABASE_URL']!,
      AUTH_RATE_LIMIT_MAX: '2',
    });
    const app = await buildApp({ config, pool: h.pool, version: 'test', mailer, store: h.store });
    try {
      const hit = (i: number) =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/magic-link',
          headers: { cookie: `os_session=forged-${i}`, authorization: `Bearer forged-${i}` },
          payload: { email: h.email('ratelimit-rotate') },
        });
      expect((await hit(1)).statusCode).toBe(200);
      expect((await hit(2)).statusCode).toBe(200);
      const limited = await hit(3);
      expect(limited.statusCode).toBe(429);
      // The plugin's error has no code; the contract still says rate_limited (click-test finding 1).
      expect(limited.json().error.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('auth routes are rate limited per IP', async () => {
    const mailer = new FakeMailer();
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: process.env['DATABASE_URL']!,
      AUTH_RATE_LIMIT_MAX: '2',
    });
    const app = await buildApp({ config, pool: h.pool, version: 'test', mailer, store: h.store });
    const hit = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/magic-link',
        payload: { email: h.email('ratelimit') },
      });
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(429);
    await app.close();
  });
});
