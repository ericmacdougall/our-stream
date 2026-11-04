// SPDX-License-Identifier: Apache-2.0
// Typed API client bound to a server and (optionally) a session. Native clients use the bearer
// transport (docs/api.md "Sessions"): sign-in calls send `x-session-transport: bearer` and get
// `sessionToken` in the body; every later call carries `Authorization: Bearer`. Every request runs
// with `credentials: 'omit'` so the platform cookie jar is neither written by sign-in nor read later:
// the SecureStore copy is the only session on the device.
import { createClient, type ApiClient } from '@our-stream/contracts';

export const TRANSPORT_HEADER = 'x-session-transport';
const SIGN_IN_PATHS = new Set(['/v1/auth/login', '/v1/auth/signup', '/v1/auth/magic-link/consume']);

export interface ApiOptions {
  apiUrl: string;
  secret?: string | null;
  /** Called for a 401 outside sign-in (the session is gone server-side) so the provider can sign out. */
  onUnauthorized?: () => void;
  /** Called for 403 `not_member` (membership deactivated): the session is useless for this org. */
  onForbidden?: (code: string) => void;
  fetch?: typeof fetch;
}

/** The `/v1/...` route of a request URL regardless of the server's own path prefix (`/api`). */
export function routeOf(url: string): string {
  const path = new URL(url).pathname;
  const i = path.indexOf('/v1/');
  return i === -1 ? path : path.slice(i);
}

export function createApi(opts: ApiOptions): ApiClient {
  const baseFetch = opts.fetch ?? fetch;
  const client = createClient({
    baseUrl: opts.apiUrl,
    ...(opts.secret ? { token: opts.secret } : {}),
    fetch: (input, init) => baseFetch(input, { ...init, credentials: 'omit' }),
  });
  client.use({
    onRequest({ request }) {
      if (SIGN_IN_PATHS.has(routeOf(request.url))) request.headers.set(TRANSPORT_HEADER, 'bearer');
      request.headers.set('accept', 'application/json');
      return request;
    },
    async onResponse({ request, response }) {
      if (SIGN_IN_PATHS.has(routeOf(request.url))) return response;
      if (response.status === 401) opts.onUnauthorized?.();
      if (response.status === 403 && opts.onForbidden) {
        try {
          const body = (await response.clone().json()) as { error?: { code?: string } };
          if (body.error?.code === 'not_member') opts.onForbidden('not_member');
        } catch {
          // Not a JSON error body: nothing to classify.
        }
      }
      return response;
    },
  });
  return client;
}

/**
 * Splits a sign-in response into the bearer secret and the profile that screens may hold: the
 * secret must never travel inside `me` (React context, dev tools, crash breadcrumbs).
 */
export function splitSignIn<T extends { sessionToken?: string }>(
  data: T,
): { secret: string | null; me: Omit<T, 'sessionToken'> } {
  const { sessionToken, ...me } = data;
  return { secret: sessionToken && sessionToken.length > 0 ? sessionToken : null, me };
}

/**
 * Revokes the server session before the local copy is cleared. Best effort: a network failure must
 * not keep a user signed in locally, and a 401 means the session was already gone.
 */
export async function logoutBestEffort(api: ApiClient): Promise<void> {
  try {
    await api.POST('/v1/auth/logout');
  } catch {
    // Offline or unreachable: the local sign-out proceeds regardless.
  }
}
