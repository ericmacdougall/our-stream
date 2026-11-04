// SPDX-License-Identifier: AGPL-3.0-only
// Media URL construction and playlist rewriting for the authenticated proxy (ADR-0003/0004). Clients
// only ever see relative paths under /media/{content}/{version}/; storage keys and hosts never leave
// the server. Asset keys written by the worker live under the version's derived/ prefix.
import { derivedPrefix } from './storage.js';

export interface VersionAssets {
  hls?: { master?: string; renditions?: unknown[] } | undefined;
  poster?: string | null | undefined;
  sprite?: string | null | undefined;
  spriteVtt?: string | null | undefined;
  captions?: Record<string, string> | undefined;
}

export interface FeedMedia {
  hls: string;
  poster: string | null;
  sprite: string | null;
  spriteVtt: string | null;
  captions: Array<{ lang: string; url: string }>;
}

const SAFE_REL = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;

/** True for a relative object path that stays under one directory (no traversal, no absolute parts). */
export function safeRelativePath(rel: string): boolean {
  if (!SAFE_REL.test(rel)) return false;
  return !rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/** Maps an asset storage key (or derived-relative path) to its path under the proxy, or null. */
export function mediaPath(
  orgId: string,
  contentId: string,
  versionId: string,
  assetKey: string | null | undefined,
): string | null {
  if (!assetKey) return null;
  const prefix = derivedPrefix(orgId, contentId, versionId);
  const rel = assetKey.startsWith(prefix) ? assetKey.slice(prefix.length) : assetKey;
  if (rel.startsWith('orgs/') || !safeRelativePath(rel)) return null;
  return `/media/${contentId}/${versionId}/${rel}`;
}

export function feedMedia(
  orgId: string,
  contentId: string,
  versionId: string,
  assets: unknown,
): FeedMedia | null {
  const a = (assets ?? {}) as VersionAssets;
  const hls = mediaPath(orgId, contentId, versionId, a.hls?.master);
  if (!hls) return null;
  const captions: FeedMedia['captions'] = [];
  for (const [lang, key] of Object.entries(a.captions ?? {})) {
    const url = mediaPath(orgId, contentId, versionId, key);
    if (url) captions.push({ lang, url });
  }
  return {
    hls,
    poster: mediaPath(orgId, contentId, versionId, a.poster),
    sprite: mediaPath(orgId, contentId, versionId, a.sprite),
    spriteVtt: mediaPath(orgId, contentId, versionId, a.spriteVtt),
    captions,
  };
}

export type MediaClass = 'playlist' | 'captions' | 'segment' | 'image' | 'other';

export function classify(rel: string): MediaClass {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.m3u8')) return 'playlist';
  if (lower.endsWith('.vtt') || lower.endsWith('.srt')) return 'captions';
  if (/\.(ts|m4s|mp4|m4a|aac|mp3|webm)$/.test(lower)) return 'segment';
  if (/\.(jpg|jpeg|png|webp|avif|gif)$/.test(lower)) return 'image';
  return 'other';
}

export function cacheControlFor(cls: MediaClass): string {
  // Playlists and captions are never cached; segments are immutable per version and may sit in the
  // browser cache for a minute (ADR-0003 accepts this window and documents it).
  return cls === 'segment' || cls === 'image' ? 'private, max-age=60' : 'private, no-store';
}

export function contentTypeFor(rel: string, fromStorage: string | null): string {
  switch (classify(rel)) {
    case 'playlist':
      return 'application/vnd.apple.mpegurl';
    case 'captions':
      return 'text/vtt; charset=utf-8';
    default:
      return fromStorage ?? 'application/octet-stream';
  }
}

/**
 * Rewrites an HLS playlist so every URI stays under the proxy. Relative URIs are kept (they resolve
 * against the playlist's own proxy URL); absolute URIs pointing into this version's derived/ prefix
 * become absolute proxy paths; anything else is dropped. With a media token, `?t=` is appended.
 */
export function rewritePlaylist(
  text: string,
  contentId: string,
  versionId: string,
  tokenQuery: string | null,
): { text: string; dropped: number } {
  const base = `/media/${contentId}/${versionId}/`;
  const marker = `/versions/${versionId}/derived/`;
  let dropped = 0;
  const rewriteUri = (uri: string): string | null => {
    const clean = uri.trim().split('?')[0] ?? '';
    if (clean.length === 0) return null;
    let rel: string;
    if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/')) {
      const i = clean.indexOf(marker);
      if (i < 0) return null;
      rel = clean.slice(i + marker.length);
      if (!safeRelativePath(rel)) return null;
      return `${base}${rel}${tokenQuery ? `?t=${tokenQuery}` : ''}`;
    }
    // Relative URIs may climb with ".." (e.g. ../captions/en.m3u8): they resolve against the playlist's
    // own proxy URL and the proxy re-authorises whatever path the player ends up requesting.
    if (!SAFE_REL.test(clean) || clean.split('/').some((seg) => seg === '' || seg === '.'))
      return null;
    return `${clean}${tokenQuery ? `?t=${tokenQuery}` : ''}`;
  };
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      out.push(line);
      continue;
    }
    if (line.startsWith('#')) {
      if (/URI="/.test(line)) {
        let failed = false;
        const replaced = line.replace(/URI="([^"]*)"/g, (_m, uri: string) => {
          const r = rewriteUri(uri);
          if (r === null) failed = true;
          return `URI="${r ?? ''}"`;
        });
        if (failed) {
          dropped += 1;
          continue;
        }
        out.push(replaced);
      } else {
        out.push(line);
      }
      continue;
    }
    const r = rewriteUri(line);
    if (r === null) {
      dropped += 1;
      continue;
    }
    out.push(r);
  }
  return { text: out.join('\n'), dropped };
}
