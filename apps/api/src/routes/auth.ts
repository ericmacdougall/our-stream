// SPDX-License-Identifier: AGPL-3.0-only
// Sign-up, password and magic-link sign-in, sessions and org switching (roadmap M1a, decision Q2).
import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import {
  AuthResponseM1b,
  LoginRequest,
  MagicLinkConsumeRequest,
  MagicLinkRequest,
  MeM1b,
  Ok,
  SignupRequest,
  SetPasswordRequest,
  SwitchOrgRequest,
} from '@our-stream/contracts';
import type { AppContext } from '../context.js';
import {
  TRANSPORT_HEADER,
  clearSessionCookie,
  csrfToken,
  requireUser,
  setSessionCookie,
  type AuthContext,
} from '../lib/auth.js';
import { normalizeEmail } from '../lib/email.js';
import { ApiError, conflict, unauthorized } from '../lib/errors.js';
import { magicLinkMail } from '../lib/mailer.js';
import {
  accountByEmail,
  accountHasPassword,
  accountSetPasswordIfUnset,
  accountCreate,
  accountGet,
  inviteAccept,
  magicLinkConsume,
  magicLinkCreate,
  membershipsOfSession,
  orgCreate,
  sessionCreate,
  sessionRevoke,
  sessionSwitchOrg,
  type Queryable,
  withPlatform,
  type MembershipRow,
} from '../lib/platform.js';
import { initDocumentsFlag } from '../lib/settings.js';
import { newSessionToken, sha256 } from '../lib/tokens.js';

// OWASP Password Storage Cheat Sheet (argon2id: m=19 MiB, t=2, p=1) as the minimum configuration.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;
// Verified against unknown accounts so a missing email costs the same time as a wrong password.
const dummyHash = argon2.hash('not-a-real-password', ARGON2_OPTIONS);

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

function firstActiveOrg(memberships: MembershipRow[]): string | null {
  return memberships.find((m) => m.status === 'active')?.orgId ?? null;
}

export async function buildMe(
  ctx: AppContext,
  userId: string,
  sessionId: string,
  tokenHash: Buffer,
  orgId: string | null,
): Promise<z.infer<typeof MeM1b>> {
  const account = await accountGet(ctx.pool, userId);
  if (!account) throw unauthorized();
  const hasPassword = await accountHasPassword(ctx.pool, userId);
  const memberships = await membershipsOfSession(ctx.pool, tokenHash);
  const current = orgId
    ? memberships.find((m) => m.orgId === orgId && m.status === 'active')
    : undefined;
  return {
    user: { id: account.id, email: account.email, displayName: account.displayName },
    org: current
      ? { id: current.orgId, slug: current.slug, name: current.name, role: current.role }
      : null,
    memberships,
    csrfToken: csrfToken(ctx.config, sessionId),
    hasPassword,
  };
}

/** Create the session, then land it on the first active org read through that very session
 * (platform_memberships_of_session binds the memberships read to a live token, migration 0005). */
async function sessionWithDefaultOrg(
  client: Queryable,
  userId: string,
  tokenHash: Buffer,
  ttlDays: number,
): Promise<{ sessionId: string; orgId: string | null }> {
  const sessionId = await sessionCreate(client, userId, null, tokenHash, ttlDays);
  const orgId = firstActiveOrg(await membershipsOfSession(client, tokenHash));
  if (orgId) await sessionSwitchOrg(client, tokenHash, orgId);
  return { sessionId, orgId };
}

async function signedIn(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  s: { token: string; sessionId: string; userId: string; orgId: string | null },
): Promise<z.infer<typeof AuthResponseM1b>> {
  // One copy of the credential per client: native clients asked for the token in the body and must
  // not also receive the cookie; web clients get the cookie only (mobile owner review).
  const wantsBearer = req.headers[TRANSPORT_HEADER] === 'bearer';
  if (!wantsBearer) setSessionCookie(reply, ctx.config, s.token);
  const me = await buildMe(ctx, s.userId, s.sessionId, sha256(s.token), s.orgId);
  return wantsBearer ? { ...me, sessionToken: s.token } : me;
}

export function registerAuthRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  // Strictly per client IP: never key on cookies or tokens the client controls.
  const authLimit = {
    rateLimit: {
      max: ctx.config.AUTH_RATE_LIMIT_MAX,
      timeWindow: '1 minute',
      keyGenerator: (req: { ip: string }) => req.ip,
    },
  };
  // Account-bound budget that holds even when the client address cannot be trusted (lib/limits.ts).
  const emailBudget = (emailNormalized: string) => {
    if (!ctx.limits.email.allow(emailNormalized))
      throw new ApiError(429, 'rate_limited', 'too many attempts for this email address');
  };

  app.post(
    '/v1/auth/signup',
    {
      config: authLimit,
      schema: { tags: ['auth'], body: SignupRequest, response: { 200: AuthResponseM1b } },
    },
    async (req, reply) => {
      const body = req.body;
      const emailNormalized = normalizeEmail(body.email);
      emailBudget(emailNormalized);
      const passwordHash = await argon2.hash(body.password, ARGON2_OPTIONS);
      const token = newSessionToken();
      const created = await withPlatform(ctx.pool, async (client) => {
        let userId: string;
        // An existing account (including an invited one that has no password yet) is never claimed
        // from an unauthenticated signup: that would let anyone who knows the address take it over.
        // Invitees sign in through their emailed link and may then set a password (/v1/auth/password).
        const existing = await accountByEmail(client, emailNormalized);
        if (existing) {
          throw conflict('email_taken', 'an account with this email already exists');
        } else {
          try {
            userId = await accountCreate(
              client,
              body.email.trim(),
              emailNormalized,
              body.displayName,
              passwordHash,
            );
          } catch (err) {
            if (isUniqueViolation(err))
              throw conflict('email_taken', 'an account with this email already exists');
            throw err;
          }
        }
        let orgId: string;
        try {
          orgId = await orgCreate(client, userId, body.orgSlug, body.orgName);
        } catch (err) {
          if (isUniqueViolation(err))
            throw conflict('slug_taken', 'this organisation slug is taken');
          throw err;
        }
        // Deployment default for the documents flag, written in the same transaction as the org.
        await initDocumentsFlag(client, orgId, ctx.config.DOCUMENTS_ENABLED_DEFAULT);
        const sessionId = await sessionCreate(
          client,
          userId,
          orgId,
          sha256(token),
          ctx.config.SESSION_TTL_DAYS,
        );
        return { userId, orgId, sessionId };
      });
      return signedIn(ctx, req, reply, { token, ...created });
    },
  );

  app.post(
    '/v1/auth/login',
    {
      config: authLimit,
      schema: { tags: ['auth'], body: LoginRequest, response: { 200: AuthResponseM1b } },
    },
    async (req, reply) => {
      // Login charges the per-email budget only on failure, so a flood of wrong passwords cannot be
      // used to lock the real owner out while they still know the right one.
      const emailNormalized = normalizeEmail(req.body.email);
      if (ctx.limits.email.exhausted(emailNormalized))
        throw new ApiError(429, 'rate_limited', 'too many attempts for this email address');
      const account = await accountByEmail(ctx.pool, emailNormalized);
      const ok = account?.passwordHash
        ? await argon2.verify(account.passwordHash, req.body.password)
        : (await argon2.verify(await dummyHash, req.body.password), false);
      if (!ok || !account) {
        ctx.limits.email.allow(emailNormalized);
        throw unauthorized('invalid_credentials', 'invalid email or password');
      }
      const token = newSessionToken();
      const tokenHash = sha256(token);
      const session = await withPlatform(ctx.pool, (client) =>
        sessionWithDefaultOrg(client, account.id, tokenHash, ctx.config.SESSION_TTL_DAYS),
      );
      return signedIn(ctx, req, reply, { token, ...session, userId: account.id });
    },
  );

  app.post(
    '/v1/auth/logout',
    {
      schema: {
        tags: ['auth'],
        response: { 200: Ok },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const auth = requireUser(req);
      await sessionRevoke(ctx.pool, auth.tokenHash);
      clearSessionCookie(reply, ctx.config);
      return { ok: true as const };
    },
  );

  app.post(
    '/v1/auth/magic-link',
    {
      config: authLimit,
      schema: { tags: ['auth'], body: MagicLinkRequest, response: { 200: Ok } },
    },
    async (req) => {
      // Always 200: the response never reveals whether the address has an account.
      const emailNormalized = normalizeEmail(req.body.email);
      emailBudget(emailNormalized);
      const account = await accountByEmail(ctx.pool, emailNormalized);
      if (account) {
        const token = newSessionToken();
        const challenge = req.body.clientChallenge
          ? Buffer.from(req.body.clientChallenge, 'base64url')
          : null;
        await magicLinkCreate(
          ctx.pool,
          account.id,
          sha256(token),
          'login',
          null,
          ctx.config.MAGIC_LINK_TTL_MINUTES,
          // base64url of the 32-byte digest (shape checked by the contract); stored as raw bytes.
          challenge,
        );
        // An app-started request mails a page on this server that hands the token to the app's
        // custom scheme (docs/api.md); `app=1` tells that page not to consume it.
        const link = `${ctx.config.APP_BASE_URL}/magic?token=${encodeURIComponent(token)}${
          challenge ? '&app=1' : ''
        }`;
        await ctx.mailer.send(magicLinkMail(account.email, link, 'login'));
      }
      return { ok: true as const };
    },
  );

  app.post(
    '/v1/auth/magic-link/consume',
    {
      config: authLimit,
      schema: { tags: ['auth'], body: MagicLinkConsumeRequest, response: { 200: AuthResponseM1b } },
    },
    async (req, reply) => {
      const token = newSessionToken();
      const result = await withPlatform(ctx.pool, async (client) => {
        const link = await magicLinkConsume(
          client,
          sha256(req.body.token),
          req.body.verifier ? sha256(req.body.verifier) : null,
        );
        if (!link)
          throw unauthorized('invalid_token', 'this link is invalid, expired or already used');
        let orgId: string | null;
        if (link.purpose === 'invite') {
          if (!link.orgId) throw unauthorized('invalid_token', 'invite link has no organisation');
          const account = await accountGet(client, link.userId);
          if (!account) throw unauthorized('invalid_token', 'account no longer exists');
          const accepted = await inviteAccept(
            client,
            link.userId,
            normalizeEmail(account.email),
            link.orgId,
          );
          if (!accepted) throw conflict('invite_invalid', 'the invitation is no longer valid');
          orgId = link.orgId;
        } else {
          orgId = null;
        }
        const session = orgId
          ? {
              sessionId: await sessionCreate(
                client,
                link.userId,
                orgId,
                sha256(token),
                ctx.config.SESSION_TTL_DAYS,
              ),
              orgId,
            }
          : await sessionWithDefaultOrg(
              client,
              link.userId,
              sha256(token),
              ctx.config.SESSION_TTL_DAYS,
            );
        return { ...session, userId: link.userId };
      });
      return signedIn(ctx, req, reply, { token, ...result });
    },
  );

  app.get(
    '/v1/me',
    {
      schema: {
        tags: ['auth'],
        response: { 200: MeM1b },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
    },
    async (req) => {
      const auth: AuthContext = requireUser(req);
      const orgId = auth.membership?.status === 'active' ? auth.orgId : null;
      return buildMe(ctx, auth.userId, auth.sessionId, auth.tokenHash, orgId);
    },
  );

  app.post(
    '/v1/me/org',
    {
      schema: {
        tags: ['auth'],
        body: SwitchOrgRequest,
        response: { 200: MeM1b },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const ok = await sessionSwitchOrg(ctx.pool, auth.tokenHash, req.body.orgId);
      if (!ok) throw conflict('not_member', 'no active membership in that organisation');
      return buildMe(ctx, auth.userId, auth.sessionId, auth.tokenHash, req.body.orgId);
    },
  );
  // Lets an account that was created by an invite (no password) choose one, from a session that proves
  // mailbox control (the invite link). Accounts that already have a password are refused.
  app.post(
    '/v1/auth/password',
    {
      schema: {
        tags: ['auth'],
        body: SetPasswordRequest,
        response: { 200: Ok },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
    },
    async (req) => {
      const auth = requireUser(req);
      // Cheap read first so a 409 never costs an argon2 hash (web owner review); the definer function
      // still decides atomically.
      if (await accountHasPassword(ctx.pool, auth.userId))
        throw conflict('password_set', 'this account already has a password');
      const passwordHash = await argon2.hash(req.body.password, ARGON2_OPTIONS);
      const ok = await withPlatform(ctx.pool, (client) =>
        accountSetPasswordIfUnset(client, auth.userId, passwordHash),
      );
      if (!ok) throw conflict('password_set', 'this account already has a password');
      return { ok: true as const };
    },
  );
}
