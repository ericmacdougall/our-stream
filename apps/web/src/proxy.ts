// SPDX-License-Identifier: AGPL-3.0-only
// Optimistic checks only (ADR-0011, Next.js auth guide): redirect on session-cookie presence so
// signed-out visitors land on /sign-in quickly. The real check happens in the Data Access Layer,
// which asks the API (GET /v1/me) on every server render; the API re-authorises every request.
import { NextResponse, type NextRequest } from 'next/server';

export const SESSION_COOKIE = 'os_session';

const PUBLIC_PATHS = new Set(['/sign-in', '/sign-up', '/magic']);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE);
  const isPublic = PUBLIC_PATHS.has(pathname);

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  // A present cookie is not a valid session (it may be stale after a server restart or revocation),
  // so signed-in-looking visitors are never bounced away from /sign-in: that would loop with the
  // DAL's redirect to /sign-in when GET /v1/me fails.
  return NextResponse.next();
}

export const config = {
  // Never run on API/media rewrites, static assets, the service worker or the manifest.
  matcher: ['/((?!api|media|_next|sw\\.js|manifest\\.webmanifest|icon\\.svg|favicon\\.ico).*)'],
};
