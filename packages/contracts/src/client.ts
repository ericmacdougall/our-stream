// SPDX-License-Identifier: AGPL-3.0-only OR Apache-2.0
import createOpenApiClient from 'openapi-fetch';
import type { paths } from './generated/openapi.js';

export interface ClientOptions {
  baseUrl: string;
  /** Bearer token for mobile and integrations; web uses cookies. */
  token?: string;
  fetch?: typeof fetch;
}

export function createClient(opts: ClientOptions) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  return createOpenApiClient<paths>({
    baseUrl: opts.baseUrl,
    headers,
    credentials: 'include',
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}
