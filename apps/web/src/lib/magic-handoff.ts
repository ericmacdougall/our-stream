// SPDX-License-Identifier: AGPL-3.0-only
// Mobile sign-in handoff: the emailed link `/magic?token=<T>&app=1` must not consume the token; it
// only hands it to the installed app through a custom-scheme link. The token rule is the app's own.

const TOKEN_RE = /^[A-Za-z0-9._~-]{20,200}$/;

export function isHandoffToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/**
 * `ourstream://magic?token=<T>&server=<origin>`, or null when the token is malformed or the origin
 * is not a plain http(s) origin (so a hostile origin string can never shape the app link).
 */
export function buildAppLink(token: string, origin: string): string | null {
  if (!isHandoffToken(token)) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== origin) return null;
  return `ourstream://magic?token=${encodeURIComponent(token)}&server=${encodeURIComponent(url.origin)}`;
}
