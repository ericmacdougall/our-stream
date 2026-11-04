// SPDX-License-Identifier: AGPL-3.0-only
// Sign-up, password and magic-link sign-in, sessions and org switching (roadmap M1a, decision Q2).
import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import {
  AuthResponse,
  LoginRequest,
  MagicLinkConsumeRequest,
  MagicLinkRequest,
  Me,
  Ok,
  SignupRequest,
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
import { conflict, unauthorized } from '../lib/errors.js';
import { magicLinkMail } from '../lib/mailer.js';
import {
  accountByEmail,
  accountCreate,
  accountGet,
  inviteAccept,
  magicLinkConsume,
  magicLinkCreate,
  membershipsOf,
  orgCreate,
  sessionCreate,
  sessionRevoke,
  sessionSwitchOrg,
  withPlatform,
  type MembershipRow,
} from '../lib/platform.js';
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
  orgId: string | null,
): Promise<z.infer<typeof Me>> {
  const account = await accountGet(ctx.pool, userId);
  if (!account) throw unauthorized();
  const memberships = await membershipsOf(ctx.pool, userId);
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
  };
}

async function signedIn(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  s: { token: string; sessionId: string; userId: string; orgId: string | null },
): Promise<z.infer<typeof AuthResponse>> {
  setSessionCookie(reply, ctx.config, s.token);
  const me = await buildMe(ctx, s.userId, s.sessionId, s.orgId);
  const wantsBearer = req.headers[TRANSPORT_HEADER] === 'bearer';
  return wantsBearer ? { ...me, sessionToken: s.token } : me;
}

export function registerAuthRoutes(fastify: FastifyInstance, ctx: AppContext): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const authLimit = {
    rateLimit: { max: ctx.config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' },
  };

  app.post(
    '/v1/auth/signup',
    {
      config: authLimit,
      schema: { tags: ['auth'], body: SignupRequest, response: { 200: AuthResponse } },
    },
    async (req, reply) => {
      const body = req.body;
      const emailNormalized = normalizeEmail(body.email);
      const passwordHash = await argon2.hash(body.password, ARGON2_OPTIONS);
      const token = newSessionToken();
      const created = await withPlatform(ctx.pool, async (client) => {
        let userId: string;
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
        let orgId: string;
        try {
          orgId = await orgCreate(client, userId, body.orgSlug, body.orgName);
        } catch (err) {
          if (isUniqueViolation(err))
            throw conflict('slug_taken', 'this organisation slug is taken');
          throw err;
        }
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
      schema: { tags: ['auth'], body: LoginRequest, response: { 200: AuthResponse } },
    },
    async (req, reply) => {
      const account = await accountByEmail(ctx.pool, normalizeEmail(req.body.email));
      const ok = account?.passwordHash
        ? await argon2.verify(account.passwordHash, req.body.password)
        : (await argon2.verify(await dummyHash, req.body.password), false);
      if (!ok || !account) throw unauthorized('invalid_credentials', 'invalid email or password');
      const memberships = await membershipsOf(ctx.pool, account.id);
      const orgId = firstActiveOrg(memberships);
      const token = newSessionToken();
      const sessionId = await sessionCreate(
        ctx.pool,
        account.id,
        orgId,
        sha256(token),
        ctx.config.SESSION_TTL_DAYS,
      );
      return signedIn(ctx, req, reply, { token, sessionId, userId: account.id, orgId });
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
      const account = await accountByEmail(ctx.pool, normalizeEmail(req.body.email));
      if (account) {
        const token = newSessionToken();
        await magicLinkCreate(
          ctx.pool,
          account.id,
          sha256(token),
          'login',
          null,
          ctx.config.MAGIC_LINK_TTL_MINUTES,
        );
        const link = `${ctx.config.APP_BASE_URL}/auth/magic?token=${encodeURIComponent(token)}`;
        await ctx.mailer.send(magicLinkMail(account.email, link, 'login'));
      }
      return { ok: true as const };
    },
  );

  app.post(
    '/v1/auth/magic-link/consume',
    {
      config: authLimit,
      schema: { tags: ['auth'], body: MagicLinkConsumeRequest, response: { 200: AuthResponse } },
    },
    async (req, reply) => {
      const token = newSessionToken();
      const result = await withPlatform(ctx.pool, async (client) => {
        const link = await magicLinkConsume(client, sha256(req.body.token));
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
          orgId = firstActiveOrg(await membershipsOf(client, link.userId));
        }
        const sessionId = await sessionCreate(
          client,
          link.userId,
          orgId,
          sha256(token),
          ctx.config.SESSION_TTL_DAYS,
        );
        return { sessionId, userId: link.userId, orgId };
      });
      return signedIn(ctx, req, reply, { token, ...result });
    },
  );

  app.get(
    '/v1/me',
    {
      schema: {
        tags: ['auth'],
        response: { 200: Me },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
    },
    async (req) => {
      const auth: AuthContext = requireUser(req);
      const orgId = auth.membership?.status === 'active' ? auth.orgId : null;
      return buildMe(ctx, auth.userId, auth.sessionId, orgId);
    },
  );

  app.post(
    '/v1/me/org',
    {
      schema: {
        tags: ['auth'],
        body: SwitchOrgRequest,
        response: { 200: Me },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const ok = await sessionSwitchOrg(ctx.pool, auth.tokenHash, req.body.orgId);
      if (!ok) throw conflict('not_member', 'no active membership in that organisation');
      return buildMe(ctx, auth.userId, auth.sessionId, req.body.orgId);
    },
  );
}
