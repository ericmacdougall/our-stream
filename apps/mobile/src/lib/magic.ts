// SPDX-License-Identifier: Apache-2.0
// Magic sign-in links reach the app as `ourstream://magic?token=...&server=<web origin>`: the mailed
// https link is a page on the user's own server that hands over to this scheme (docs/api.md), so no
// associated domains are needed. `exp://.../--/magic` is accepted for the Expo dev client. The token
// is consumed only against the server the request was started on (magic-verifier.ts); it is never
// logged or shown.

const PATHS = new Set(['/auth/magic', '/magic', 'auth/magic', 'magic']);
const TOKEN = /^[A-Za-z0-9._~-]{20,200}$/;

export interface MagicLink {
  token: string;
  /** Origin the link names (`server` parameter), or null when absent or not an http(s) origin. */
  server: string | null;
}

/** `scheme://host[:port]` of an http(s) URL; null for anything else. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

export function parseMagicLink(url: string): MagicLink | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Only the app scheme (and the dev client) carries a link; a plain https URL is never one.
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return null;
  // Custom schemes parse the first segment as the host (ourstream://auth/magic → host "auth").
  let path = `${parsed.hostname}${parsed.pathname.replace(/\/+$/, '')}`;
  // Expo dev client links put the app path after `/--/`.
  const dev = path.indexOf('/--/');
  if (dev !== -1) path = path.slice(dev + 3);
  if (!PATHS.has(path)) return null;
  const token = parsed.searchParams.get('token');
  if (!token || !TOKEN.test(token)) return null;
  const server = parsed.searchParams.get('server');
  return { token, server: server ? originOf(server) : null };
}
