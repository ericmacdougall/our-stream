// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { externalHost, isHlsUrl, isSafeMediaPath } from './links.js';

describe('isSafeMediaPath', () => {
  it('accepts relative proxy paths only', () => {
    expect(isSafeMediaPath('/media/c1/v1/hls/master.m3u8')).toBe(true);
    expect(isSafeMediaPath('/media/c1/v1/captions/en.vtt')).toBe(true);
  });
  it('refuses other origins, traversal and query tokens', () => {
    for (const bad of [
      'https://storage.example/media/x.m3u8',
      '//evil.example/media/x.m3u8',
      '/api/v1/feed',
      '/media/../v1/me',
      '/media/c1/./x.m3u8',
      '/media/c1/v1/master.m3u8?token=abc',
      '/media/c1\\v1\\x',
      'media/c1/v1/x.m3u8',
    ]) {
      expect(isSafeMediaPath(bad), bad).toBe(false);
    }
  });
});

describe('externalHost', () => {
  it('returns the host for http(s) and null otherwise', () => {
    expect(externalHost('https://example.com/path?x=1')).toBe('example.com');
    expect(externalHost('http://intranet.local:8080/')).toBe('intranet.local:8080');
    expect(externalHost('javascript:alert(1)')).toBeNull();
    expect(externalHost('not a url')).toBeNull();
  });
});

describe('isHlsUrl', () => {
  it('detects playlists by extension', () => {
    expect(isHlsUrl('/media/a/b/hls/master.m3u8')).toBe(true);
    expect(isHlsUrl('/media/a/b/clip.mp4')).toBe(false);
  });
});
