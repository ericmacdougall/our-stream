// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isCacheableStatic, isNeverCached } from './sw-rules.js';

const origin = 'https://app.example';
const u = (path: string, o = origin) => new URL(path, o);

describe('service worker caching rules (ADR-0004)', () => {
  it('never caches /api, /media or the worker itself', () => {
    for (const p of ['/api', '/api/v1/feed', '/media', '/media/c/v/hls/master.m3u8', '/sw.js']) {
      expect(isNeverCached(p), p).toBe(true);
      expect(isCacheableStatic(u(p), origin), p).toBe(false);
    }
    // Even with a static-looking extension.
    expect(isCacheableStatic(u('/media/c/v/poster.jpg'), origin)).toBe(false);
    expect(isCacheableStatic(u('/api/v1/content/x.js'), origin)).toBe(false);
  });
  it('caches only same-origin Next static chunks and static asset extensions', () => {
    expect(isCacheableStatic(u('/_next/static/chunks/app.js'), origin)).toBe(true);
    expect(isCacheableStatic(u('/icon.svg'), origin)).toBe(true);
    expect(isCacheableStatic(u('/fonts/inter.woff2'), origin)).toBe(true);
    expect(isCacheableStatic(u('/_next/data/x.json'), origin)).toBe(false);
    expect(isCacheableStatic(u('/_next/image?url=x'), origin)).toBe(false);
    expect(isCacheableStatic(u('/'), origin)).toBe(false);
    expect(isCacheableStatic(u('/streams'), origin)).toBe(false);
    expect(isCacheableStatic(u('/manifest.webmanifest'), origin)).toBe(false);
  });
  it('ignores other origins entirely', () => {
    expect(isCacheableStatic(u('/_next/static/a.js', 'https://cdn.evil'), origin)).toBe(false);
  });
});
