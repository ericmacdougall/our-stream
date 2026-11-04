// SPDX-License-Identifier: AGPL-3.0-only
// Opaque secrets and their derivations. Only hashes are stored; the CSRF and media tokens are HMACs so
// the server keeps no extra state for them (ADR-0003 media token, double-submit CSRF).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest();
}

function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** CSRF token for the double-submit header: bound to the session id, derived, never stored. */
export function csrfTokenFor(secret: string, sessionId: string): string {
  return hmac(secret, `csrf:${sessionId}`);
}

export function csrfTokenValid(secret: string, sessionId: string, presented: string): boolean {
  return safeEqual(csrfTokenFor(secret, sessionId), presented);
}

/**
 * Media token for native players that cannot send cookies on segment requests:
 * HMAC-SHA256(secret, userId|orgId|versionId|mediaKeyId|exp). The org is carried so the proxy can open
 * the tenant context; the token is only a transport for identity and the proxy still re-authorises
 * every request against the database (ADR-0003).
 */
export interface MediaTokenClaims {
  userId: string;
  orgId: string;
  versionId: string;
  mediaKeyId: string;
  /** Unix seconds. */
  exp: number;
}

function mediaSignature(secret: string, c: MediaTokenClaims): string {
  return hmac(secret, `${c.userId}|${c.orgId}|${c.versionId}|${c.mediaKeyId}|${c.exp}`);
}

export function signMediaToken(secret: string, c: MediaTokenClaims): string {
  return `v1.${c.userId}.${c.orgId}.${c.exp}.${mediaSignature(secret, c)}`;
}

export interface ParsedMediaToken {
  userId: string;
  orgId: string;
  exp: number;
  sig: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMediaToken(token: string): ParsedMediaToken | null {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, userId, orgId, expStr, sig] = parts as [string, string, string, string, string];
  const exp = Number(expStr);
  if (!UUID_RE.test(userId) || !UUID_RE.test(orgId) || !Number.isInteger(exp) || !sig) return null;
  return { userId, orgId, exp, sig };
}

/** Verifies the signature for the server-side facts; the caller supplies versionId and mediaKeyId. */
export function mediaTokenValid(
  secret: string,
  parsed: ParsedMediaToken,
  versionId: string,
  mediaKeyId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (parsed.exp <= nowSeconds) return false;
  const expected = mediaSignature(secret, {
    userId: parsed.userId,
    orgId: parsed.orgId,
    versionId,
    mediaKeyId,
    exp: parsed.exp,
  });
  return safeEqual(expected, parsed.sig);
}
