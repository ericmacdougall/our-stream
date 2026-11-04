// SPDX-License-Identifier: AGPL-3.0-only
// Data Access Layer (ADR-0011): server components and route handlers reach the API only through
// this module. It forwards the incoming session cookie and never caches personalised responses.
import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { createClient, type ApiClient } from '@our-stream/contracts';
import { SESSION_COOKIE } from '@/proxy';

export function apiBaseUrl(): string {
  return (process.env['API_INTERNAL_URL'] ?? 'http://localhost:4000').replace(/\/$/, '');
}

/** A typed client bound to the current request's cookies. */
export async function serverApi(): Promise<ApiClient> {
  const jar = await cookies();
  // Least privilege: only the session cookie travels to the API, never unrelated cookies.
  const session = jar.get(SESSION_COOKIE);
  const cookieHeader = session ? `${SESSION_COOKIE}=${session.value}` : '';
  return createClient({
    baseUrl: apiBaseUrl(),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (cookieHeader) headers.set('cookie', cookieHeader);
      return fetch(input, { ...init, headers, cache: 'no-store' });
    },
  });
}

export type Me = NonNullable<Awaited<ReturnType<typeof getMe>>>;

/**
 * The signed-in user, or null when there is no valid session (401) or the API is unreachable.
 * Memoised per request (React cache) so the layout and a page share one GET /v1/me.
 */
export const getMe = cache(async () => {
  const jar = await cookies();
  if (!jar.has(SESSION_COOKIE)) return null;
  try {
    const api = await serverApi();
    const { data } = await api.GET('/v1/me');
    return data ?? null;
  } catch {
    return null;
  }
});
