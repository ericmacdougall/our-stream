// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next.js';

describe('safeNext', () => {
  it('keeps same-origin paths', () => {
    expect(safeNext('/upload')).toBe('/upload');
    expect(safeNext('/content/abc/publish?x=1')).toBe('/content/abc/publish?x=1');
    expect(safeNext(['/streams', '/other'])).toBe('/streams');
  });
  it('refuses open-redirect shapes', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '/foo\\bar',
      'upload',
      '',
      undefined,
      '/ok\nhttp://evil',
    ]) {
      expect(safeNext(bad), String(bad)).toBe('/');
    }
  });
  it('refuses same-origin non-page targets (API, media, build assets, service worker)', () => {
    for (const bad of [
      '/api/v1/me',
      '/api',
      '/media/x/hls/master.m3u8',
      '/_next/static/chunk.js',
      '/sw.js',
      '/manifest.webmanifest',
      '/api?x=1',
      '/API/v1/me',
      '/Media/x',
      '/sw.js/',
    ]) {
      expect(safeNext(bad), bad).toBe('/');
    }
    // Pages whose names merely start with those letters are still fine.
    expect(safeNext('/apiary')).toBe('/apiary');
    expect(safeNext('/mediation')).toBe('/mediation');
  });
});
