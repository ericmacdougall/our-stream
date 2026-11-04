// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
import createOpenApiClient from 'openapi-fetch';
import type { paths } from './generated/openapi.js';
import type { M1aPaths } from './m1a-paths.js';

export interface ClientOptions {
  baseUrl: string;
  /** Bearer token for mobile and integrations; web uses cookies. */
  token?: string;
  fetch?: typeof fetch;
}

/** Generated paths plus the hand-typed M1a routes until the API emits them (see m1a-paths.ts). */
export type ApiPaths = paths & M1aPaths;
export type ApiClient = ReturnType<typeof createClient>;

export function createClient(opts: ClientOptions) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  return createOpenApiClient<ApiPaths>({
    baseUrl: opts.baseUrl,
    headers,
    credentials: 'include',
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}
