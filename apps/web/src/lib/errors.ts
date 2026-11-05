// SPDX-License-Identifier: AGPL-3.0-only
// Maps API error codes to catalog messages; unknown codes get neutral copy so nothing leaks.
import { documentErrorMessageId } from './documents';
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
};

export function describeError(code: string | undefined, status?: number): string {
  const documentMessage = documentErrorMessageId(code);
  if (documentMessage) return t(documentMessage);
  if (code && KNOWN[code]) return t(KNOWN[code]);
  if (status === 401) return t('error.unauthorized');
  if (status === 403) return t('error.forbidden');
  if (status === 404) return t('error.notFound');
  if (status === 409) return t('error.conflict');
  if (status === 429) return t('error.rateLimited');
  if (status !== undefined && status >= 400 && status < 500) return t('error.badRequest');
  return t('error.generic');
}

/** openapi-fetch returns {data, error, response}; normalise into a message or null. */
export function errorMessage(result: {
  error?: unknown;
  response?: Response | { status: number };
}): string | null {
  if (result.error === undefined) return null;
  const code =
    result.error && typeof result.error === 'object' && 'error' in result.error
      ? (result.error as { error?: { code?: string } }).error?.code
      : undefined;
  return describeError(code, result.response?.status);
}
