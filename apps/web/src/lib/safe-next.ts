// SPDX-License-Identifier: AGPL-3.0-only
// Post-sign-in destination: same-origin paths only, never another site. Browsers normalise a
// backslash to a slash, so "/\\evil.example" would become protocol-relative; refuse it as well as
// anything that is not a single absolute path.
// Same-origin paths that are not pages (the proxy matcher's exclusions): landing a person on raw JSON
// or a media segment is never the intended destination.
const RESERVED =
  /^\/(api|media|_next)(\/|$)|^\/(sw\.js|manifest\.webmanifest|icon\.svg|favicon\.ico)\/*$/i;

export function safeNext(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return '/';
  if (!/^\/(?![/\\])[^\\]*$/.test(v)) return '/';
  // No whitespace or control characters (header splitting, confusable paths).
  for (const ch of v) if (ch.charCodeAt(0) < 0x20 || /\s/.test(ch)) return '/';
  if (RESERVED.test(v.split(/[?#]/, 1)[0] ?? v)) return '/';
  return v;
}
