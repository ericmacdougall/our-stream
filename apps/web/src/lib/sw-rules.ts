// SPDX-License-Identifier: AGPL-3.0-only
// Pure rules shared by the service worker and its unit tests. Only same-origin static assets are
// ever cacheable; /api and /media are personalised and never touched (ADR-0003/0004).
const STATIC_EXT = /\.(?:js|css|woff2?|ttf|svg|png|jpe?g|webp|gif|ico)$/i;

export function isNeverCached(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/media' ||
    pathname.startsWith('/media/') ||
    pathname === '/sw.js'
  );
}

export function isCacheableStatic(url: URL, origin: string): boolean {
  if (url.origin !== origin) return false;
  if (isNeverCached(url.pathname)) return false;
  if (url.pathname.startsWith('/_next/static/')) return true;
  if (url.pathname.startsWith('/_next/')) return false;
  return STATIC_EXT.test(url.pathname);
}
