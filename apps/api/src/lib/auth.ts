// SPDX-License-Identifier: AGPL-3.0-only
// Request authentication. The session token arrives as the `os_session` cookie (web) or a bearer token
// (mobile, integrations); only its SHA-256 is stored. Membership status, role and authz_epoch are read
// from the database on every request and never from the cookie (ADR-0002, ADR-0004).
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withTenant } from '@our-stream/db';
import type { Config } from '../config.js';
import { forbidden, unauthorized } from './errors.js';
import { sessionLookup, type MembershipStatus, type OrgRole } from './platform.js';
import { csrfTokenFor, csrfTokenValid, sha256 } from './tokens.js';

export const SESSION_COOKIE = 'os_session';
export const CSRF_HEADER = 'x-csrf-token';
/** Clients that cannot use cookies send this header on sign-in to receive the token in the body. */
export const TRANSPORT_HEADER = 'x-session-transport';

export interface Membership {
  role: OrgRole;
  status: MembershipStatus;
  authzEpoch: number;
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  tokenHash: Buffer;
  viaCookie: boolean;
  orgId: string | null;
  membership: Membership | null;
}

export type MemberContext = AuthContext & { orgId: string; membership: Membership };

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function extractToken(req: FastifyRequest): { token: string; viaCookie: boolean } | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token.length > 0) return { token, viaCookie: false };
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (typeof cookie === 'string' && cookie.length > 0) return { token: cookie, viaCookie: true };
  return null;
}

export async function resolveAuth(req: FastifyRequest, pool: pg.Pool): Promise<AuthContext | null> {
  const presented = extractToken(req);
  if (!presented) return null;
  const tokenHash = sha256(presented.token);
  const session = await sessionLookup(pool, tokenHash);
  if (!session) return null;
  let membership: Membership | null = null;
  if (session.orgId) {
    membership = await withTenant(
      pool,
      { orgId: session.orgId, userId: session.userId },
      async (client) => {
        const r = await client.query<{
          role: OrgRole;
          status: MembershipStatus;
          authz_epoch: string;
        }>(
          'SELECT role, status, authz_epoch::text FROM org_membership WHERE org_id = $1 AND user_id = $2',
          [session.orgId, session.userId],
        );
        const row = r.rows[0];
        return row
          ? { role: row.role, status: row.status, authzEpoch: Number(row.authz_epoch) }
          : null;
      },
    );
  }
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    tokenHash,
    viaCookie: presented.viaCookie,
    orgId: session.orgId,
    membership,
  };
}

export function requireUser(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** An active membership in the session's org; deactivated members are refused on every request. */
export function requireMember(req: FastifyRequest): MemberContext {
  const auth = requireUser(req);
  if (!auth.orgId || !auth.membership) throw forbidden('no_org', 'no organisation selected');
  if (auth.membership.status !== 'active')
    throw forbidden('not_member', 'membership is not active');
  return auth as MemberContext;
}

export function requireRole(req: FastifyRequest, roles: readonly OrgRole[]): MemberContext {
  const m = requireMember(req);
  if (!roles.includes(m.membership.role))
    throw forbidden('role_forbidden', `requires one of: ${roles.join(', ')}`);
  return m;
}

export const ADMIN_ROLES: readonly OrgRole[] = ['owner', 'admin'];
export const PUBLISHER_ROLES: readonly OrgRole[] = ['owner', 'admin', 'announcer', 'contributor'];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originAllowed(req: FastifyRequest, config: Config): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    // Browsers send Sec-Fetch-Site on all requests; same-origin fetches without Origin are fine.
    return req.headers['sec-fetch-site'] === 'same-origin';
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin === new URL(config.APP_BASE_URL).origin) return true;
  // Same-origin deployments (web and API behind one host).
  return parsed.host === req.host;
}

/**
 * CSRF for cookie-authenticated mutations: either the double-submit header (HMAC of the session id,
 * handed out by GET /v1/me) or a trusted Origin. Bearer requests carry no ambient credential and skip.
 */
export function enforceCsrf(req: FastifyRequest, config: Config): void {
  if (SAFE_METHODS.has(req.method)) return;
  const auth = req.auth;
  if (!auth || !auth.viaCookie) return;
  const header = req.headers[CSRF_HEADER];
  if (typeof header === 'string' && csrfTokenValid(config.SESSION_SECRET, auth.sessionId, header))
    return;
  if (originAllowed(req, config)) return;
  throw forbidden('csrf', 'missing or invalid CSRF token');
}

export function csrfToken(config: Config, sessionId: string): string {
  return csrfTokenFor(config.SESSION_SECRET, sessionId);
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/',
    maxAge: config.SESSION_TTL_DAYS * 24 * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: config.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: '/',
  });
}
