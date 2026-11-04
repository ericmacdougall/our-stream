// SPDX-License-Identifier: AGPL-3.0-only
// Browser-side typed client. Calls go to the same origin under /api (rewritten to the API) so the
// HttpOnly session cookie travels same-site. Mutations carry the CSRF token from GET /v1/me.
import { createClient, type ApiClient } from '@our-stream/contracts';

let csrfToken: string | null = null;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

let singleton: ApiClient | null = null;

export function browserApi(): ApiClient {
  if (singleton) return singleton;
  const client = createClient({ baseUrl: '/api' });
  client.use({
    onRequest({ request }) {
      if (csrfToken && MUTATING.has(request.method)) {
        request.headers.set('x-csrf-token', csrfToken);
      }
      return request;
    },
  });
  singleton = client;
  return client;
}

/** Extracts a human-safe error code from an API error body. */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'error' in error) {
    const e = (error as { error?: { code?: string } }).error;
    if (e?.code) return e.code;
  }
  return 'unknown';
}
