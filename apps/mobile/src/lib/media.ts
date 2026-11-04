// SPDX-License-Identifier: Apache-2.0
// Media URLs for the native player and share text. The API gives relative proxy paths
// (`/media/{content}/{version}/...`); the short-lived media token travels as `?t=` (docs/api.md).
// Share links use the server's `linkPath` on the web origin and never a media URL or a token.

const MEDIA_PREFIX = '/media/';
/** Refresh the token when fewer than this many ms remain, so a playlist fetched now still works. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export function mediaUrl(apiUrl: string, proxyPath: string, token: string): string {
  if (!proxyPath.startsWith(MEDIA_PREFIX) || proxyPath.includes('?') || proxyPath.includes('#')) {
    throw new Error('not a media proxy path');
  }
  return `${apiUrl}${proxyPath}?t=${encodeURIComponent(token)}`;
}

export function tokenNeedsRefresh(
  expiresAt: string,
  nowMs: number,
  marginMs = TOKEN_REFRESH_MARGIN_MS,
): boolean {
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return true;
  return exp - nowMs < marginMs;
}

/** The URL without its token, for display and diagnostics. */
export function redactMediaUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function shareText(webUrl: string, linkPath: string): string {
  if (
    !linkPath.startsWith('/') ||
    linkPath.startsWith('//') ||
    /[\\\s]/.test(linkPath) ||
    linkPath.includes(':')
  ) {
    throw new Error('linkPath must be a relative path');
  }
  if (linkPath.startsWith(MEDIA_PREFIX)) throw new Error('refusing to share a media url');
  if (/[?&]t=/.test(linkPath)) throw new Error('refusing to share a token');
  return `${webUrl}${linkPath}`;
}
