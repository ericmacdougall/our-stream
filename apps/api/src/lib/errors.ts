// SPDX-License-Identifier: AGPL-3.0-only
// API errors carry a stable machine-readable code (ErrorResponse.error.code) next to the HTTP status.
import { AuthzRuleError } from '@our-stream/authz';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (code: string, message: string) => new ApiError(400, code, message);
export const unauthorized = (code = 'unauthenticated', message = 'sign in required') =>
  new ApiError(401, code, message);
export const forbidden = (code: string, message: string) => new ApiError(403, code, message);
export const notFound = (code = 'not_found', message = 'not found') =>
  new ApiError(404, code, message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);

/** Tuple rule violations are authorization failures (403) except for missing targets (404). */
export function fromAuthzError(err: unknown): unknown {
  if (err instanceof AuthzRuleError) {
    if (err.code === 'no_such_stream' || err.code === 'no_such_group')
      return new ApiError(404, err.code, err.message);
    return new ApiError(403, err.code, err.message);
  }
  return err;
}

/** Postgres raises from definer functions arrive as generic errors; map the known messages. */
export function fromDbError(err: unknown): unknown {
  const message = (err as { message?: string }).message ?? '';
  const code = (err as { code?: string }).code;
  if (code === '23505') return new ApiError(409, 'conflict', 'already exists');
  if (message.includes('expires_at must be after publish_at'))
    return badRequest('bad_expiry', 'expiresAt must be after publishAt');
  // Migration 0013 raises `content_publish: feature_disabled: ...` for a document while the org flag or
  // the deployment kill switch is off.
  if (message.includes('feature_disabled'))
    return forbidden('feature_disabled', 'documents are not enabled for this organisation');
  if (message.includes('not awaiting upload'))
    return conflict('already_completed', 'this upload was already completed');
  if (message.includes('content not found or retracted'))
    return conflict('retracted', 'content is retracted');
  if (message.includes('already retracted')) return conflict('retracted', 'already retracted');
  return err;
}
