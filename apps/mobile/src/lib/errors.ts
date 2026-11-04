// SPDX-License-Identifier: Apache-2.0
// Maps API error codes (docs/api.md, m1b.ts header) to catalog copy; unknown codes get neutral
// copy by status so no server message is echoed.
import { strings } from '../i18n';

const e = strings.errors;
const KNOWN: Record<string, string> = {
  invalid_credentials: e.invalidCredentials,
  invalid_token: e.invalidLink,
  unauthenticated: e.sessionExpired,
  not_member: e.forbidden,
  role_forbidden: e.forbidden,
  moderation_forbidden: e.forbidden,
  rate_limited: e.rateLimited,
  comments_disabled: e.commentsDisabled,
  comment_blocked: e.commentBlocked,
  bad_parent: e.commentGone,
  comment_not_found: e.commentGone,
  idempotency_mismatch: e.generic,
  content_not_found: e.unavailable,
  retracted: e.unavailable,
  no_media: e.unavailable,
  stale_version: e.unavailable,
  bad_cursor: e.generic,
  validation: e.badRequest,
  self_share: e.selfShare,
};

export function errorCodeOf(result: { error?: unknown }): string {
  const err = result.error;
  if (err && typeof err === 'object' && 'error' in err) {
    const inner = (err as { error?: { code?: unknown } }).error;
    if (inner && typeof inner.code === 'string') return inner.code;
  }
  return 'unknown';
}

export function describeError(code: string | undefined, status?: number): string {
  if (code && KNOWN[code]) return KNOWN[code];
  if (status === 401) return e.sessionExpired;
  if (status === 403) return e.forbidden;
  if (status === 404) return e.unavailable;
  if (status === 429) return e.rateLimited;
  if (status !== undefined && status >= 400 && status < 500) return e.badRequest;
  return e.generic;
}

/** True when the item should be treated as gone (retracted, expired, or never visible). */
export function isUnavailable(code: string, status?: number): boolean {
  return (
    status === 404 || code === 'content_not_found' || code === 'retracted' || code === 'no_media'
  );
}

/** openapi-fetch result → message or null when the call succeeded. */
export function errorMessage(result: {
  error?: unknown;
  response?: { status: number };
}): string | null {
  if (result.error === undefined) return null;
  return describeError(errorCodeOf(result), result.response?.status);
}
