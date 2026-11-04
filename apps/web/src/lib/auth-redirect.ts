// SPDX-License-Identifier: AGPL-3.0-only
// Where /sign-in and /sign-up send a visitor who already has a valid session. Null means "render the
// form": a cookie that no longer maps to a session makes the DAL return null, and rendering the form
// (instead of redirecting) is what keeps proxy.ts, requireMe and these pages from looping.
import { safeNext } from './safe-next';

const AUTH_PAGES = new Set(['/sign-in', '/sign-up', '/magic']);

export function signedInDestination(
  me: object | null | undefined,
  next: string | string[] | undefined,
): string | null {
  if (!me) return null;
  const target = safeNext(next);
  // Compare the path only, case-folded and without trailing slashes, so "/Sign-In/" cannot slip past.
  const pathname = (target.split(/[?#]/, 1)[0] ?? target).toLowerCase().replace(/\/+$/, '') || '/';
  // A ?next pointing back at an auth page would redirect in a circle; go home instead.
  return AUTH_PAGES.has(pathname) ? '/' : target;
}
