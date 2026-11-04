// SPDX-License-Identifier: AGPL-3.0-only
// Media URLs from the API are relative proxy paths under /media (ADR-0003). Anything else is
// refused so a compromised payload cannot point the player at another origin.
export function isSafeMediaPath(url: string): boolean {
  if (!url.startsWith('/media/')) return false;
  if (url.startsWith('//') || url.includes('\\')) return false;
  if (/[?#]/.test(url)) return false;
  const segments = url.split('/');
  return !segments.some((s) => s === '..' || s === '.');
}

/** Host shown in the external-link interstitial; null when the URL is not http(s). */
export function externalHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host;
  } catch {
    return null;
  }
}

/** True when a media URL is an HLS playlist (otherwise the player uses a progressive source). */
export function isHlsUrl(url: string): boolean {
  return /\.m3u8$/i.test(url);
}
