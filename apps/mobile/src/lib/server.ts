// SPDX-License-Identifier: Apache-2.0
// Manual server entry (the Q5 fallback when an organisation publishes no discovery document):
// the user types the address they use in the browser; the app probes `/v1/meta` (bare API origin)
// and then `/api/v1/meta` (web origin that proxies the API, see apps/web/next.config.ts).
import { MetaResponse } from '@our-stream/contracts';
import { validateServerUrl, type FetchLike, type ServerConfig, type UrlOptions } from './discovery';

export function normaliseServerInput(raw: string, opts: UrlOptions = {}): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return validateServerUrl(withScheme, opts);
}

const PROBE_TIMEOUT_MS = 8_000;

async function isOurStream(url: string, fetch: FetchLike): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/v1/meta`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
      credentials: 'omit',
    });
    if (!res.ok) return false;
    const body = (await res.text()).slice(0, 4096);
    return MetaResponse.safeParse(JSON.parse(body)).success;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves a validated base URL to a server configuration, or null when no our-stream API answers. */
export async function probeServer(
  base: string,
  deps: { fetch: FetchLike },
): Promise<ServerConfig | null> {
  if (await isOurStream(base, deps.fetch)) return { apiUrl: base, webUrl: base };
  if (await isOurStream(`${base}/api`, deps.fetch)) return { apiUrl: `${base}/api`, webUrl: base };
  return null;
}
