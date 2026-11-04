// SPDX-License-Identifier: AGPL-3.0-only
// Post-sign-in destination: same-origin paths only, never another site. Browsers normalise a
// backslash to a slash, so "/\\evil.example" would become protocol-relative; refuse it as well as
// anything that is not a single absolute path.
export function safeNext(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return '/';
  if (!/^\/(?![/\\])[^\\]*$/.test(v)) return '/';
  // No whitespace or control characters (header splitting, confusable paths).
  for (const ch of v) if (ch.charCodeAt(0) < 0x20 || /\s/.test(ch)) return '/';
  return v;
}
