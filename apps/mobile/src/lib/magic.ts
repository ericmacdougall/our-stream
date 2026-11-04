// SPDX-License-Identifier: Apache-2.0
// Magic sign-in links: the API mails `${APP_BASE_URL}/magic?token=...` (docs/api.md). The app
// receives it as a universal link, as `ourstream://magic?token=...` (the older `/auth/magic` path is
// still accepted), or through the Expo dev client (`exp://.../--/magic`). The token is consumed
// against the last confirmed server only; it is never logged or shown.

const PATHS = new Set(['/auth/magic', '/magic', 'auth/magic', 'magic']);
const TOKEN = /^[A-Za-z0-9._~-]{20,200}$/;

export function magicTokenFromUrl(url: string): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Custom schemes parse the first segment as the host (ourstream://auth/magic → host "auth").
  let path = parsed.pathname.replace(/\/+$/, '');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    path = `${parsed.hostname}${path}`;
  // Expo dev client links put the app path after `/--/`.
  const dev = path.indexOf('/--/');
  if (dev !== -1) path = path.slice(dev + 3);
  if (!PATHS.has(path)) return null;
  const token = parsed.searchParams.get('token');
  return token && TOKEN.test(token) ? token : null;
}
