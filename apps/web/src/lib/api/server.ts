// SPDX-License-Identifier: AGPL-3.0-only
// Data Access Layer (ADR-0011): server components and route handlers reach the API only through
// this module. It forwards the incoming session cookie and never caches personalised responses.
import 'server-only';
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

/** The signed-in user, or null when there is no valid session (401) or the API is unreachable. */
export async function getMe() {
  const jar = await cookies();
  if (!jar.has(SESSION_COOKIE)) return null;
  try {
    const api = await serverApi();
    const { data } = await api.GET('/v1/me');
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * The org's documents flag as the API reports it (any member may read it): true/false, or null when the
 * settings could not be read (the API then decides per request). The deployment kill switch is not part
 * of it; it surfaces as 403 `feature_disabled` on the actions themselves.
 */
export async function getDocumentsEnabled(): Promise<boolean | null> {
  try {
    const api = await serverApi();
    const { data } = await api.GET('/v1/org/settings');
    return data ? data.documentsEnabled : null;
  } catch {
    return null;
  }
}
