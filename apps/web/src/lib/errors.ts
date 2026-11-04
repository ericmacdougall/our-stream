// SPDX-License-Identifier: AGPL-3.0-only
// Maps API error codes to catalog messages; unknown codes get neutral copy so nothing leaks.
import { t, type MessageId } from './i18n';

const KNOWN: Record<string, MessageId> = {
  invalid_credentials: 'error.invalidCredentials',
  unauthorized: 'error.unauthorized',
  forbidden: 'error.forbidden',
  not_found: 'error.notFound',
  conflict: 'error.conflict',
  slug_taken: 'error.slugTaken',
  email_taken: 'error.emailTaken',
  bad_request: 'error.badRequest',
  validation: 'error.badRequest',
  rate_limited: 'error.rateLimited',
  csrf: 'error.sessionExpired',
  token_invalid: 'error.tokenInvalid',
  token_expired: 'error.tokenInvalid',
  // M1b (packages/contracts/src/m1b.ts header).
  comments_disabled: 'error.commentsDisabled',
  comment_blocked: 'error.commentBlocked',
  comment_not_found: 'error.commentGone',
  bad_parent: 'error.commentGone',
  idempotency_mismatch: 'error.idempotencyMismatch',
  moderation_forbidden: 'error.forbidden',
  pin_forbidden: 'error.pinForbidden',
  not_in_audience: 'error.notInAudience',
  not_published: 'error.unavailable',
  self_share: 'error.selfShare',
  stale_version: 'error.unavailable',
  content_not_found: 'error.unavailable',
  bad_cursor: 'error.generic',
};

export function describeError(code: string | undefined, status?: number): string {
  if (code && KNOWN[code]) return t(KNOWN[code]);
  if (status === 401) return t('error.unauthorized');
  if (status === 403) return t('error.forbidden');
  if (status === 404) return t('error.notFound');
  if (status === 409) return t('error.conflict');
  if (status === 429) return t('error.rateLimited');
  if (status !== undefined && status >= 400 && status < 500) return t('error.badRequest');
  return t('error.generic');
}

/**
 * openapi-fetch returns {data, error, response}; normalise into a message or null. Success needs a
 * 2xx status: openapi-fetch yields `error: undefined` for any empty-body response, including a
 * 502/504 from a proxy, which must never read as success.
 */
export function errorMessage(result: {
  error?: unknown;
  response?: Response | { status: number };
}): string | null {
  const status = result.response?.status;
  const ok = status === undefined || (status >= 200 && status < 300);
  if (result.error === undefined && ok) return null;
  const code =
    result.error && typeof result.error === 'object' && 'error' in result.error
      ? (result.error as { error?: { code?: string } }).error?.code
      : undefined;
  return describeError(code, result.response?.status);
}
