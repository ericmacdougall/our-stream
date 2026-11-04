// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { mediaUrl, redactMediaUrl, shareText, tokenNeedsRefresh } from './media';

describe('mediaUrl', () => {
  it('prefixes the server and appends the media token', () => {
    expect(mediaUrl('https://x.com/api', '/media/c/v/hls/master.m3u8', 'a.b/c=')).toBe(
      'https://x.com/api/media/c/v/hls/master.m3u8?t=a.b%2Fc%3D',
    );
  });
  it('refuses anything that is not a proxy path', () => {
    expect(() => mediaUrl('https://x.com', 'https://storage.example/obj', 't')).toThrow();
    expect(() => mediaUrl('https://x.com', '/v1/feed', 't')).toThrow();
    expect(() => mediaUrl('https://x.com', '//evil/media/x', 't')).toThrow();
    expect(() => mediaUrl('https://x.com', '/media/c/v/x?t=old', 't')).toThrow();
  });
});

describe('tokenNeedsRefresh', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  it('is true within the safety margin, after expiry and for unparseable dates', () => {
    expect(tokenNeedsRefresh('2026-01-01T00:00:30Z', now)).toBe(true);
    expect(tokenNeedsRefresh('2025-12-31T23:59:00Z', now)).toBe(true);
    expect(tokenNeedsRefresh('garbage', now)).toBe(true);
  });
  it('is false with comfortable time left', () => {
    expect(tokenNeedsRefresh('2026-01-01T00:05:00Z', now)).toBe(false);
  });
});

describe('redactMediaUrl', () => {
  it('drops the token so the url can be shown or logged', () => {
    expect(redactMediaUrl('https://x.com/media/c/v/m.m3u8?t=secretvalue')).toBe(
      'https://x.com/media/c/v/m.m3u8',
    );
    expect(redactMediaUrl('https://x.com/media/c/v/m.m3u8')).toBe('https://x.com/media/c/v/m.m3u8');
  });
});

describe('shareText', () => {
  it('is the web origin plus the server-provided link path', () => {
    expect(shareText('https://stream.example.com', '/content/abc')).toBe(
      'https://stream.example.com/content/abc',
    );
  });
  it('never produces a media url, an absolute url or a token', () => {
    expect(() => shareText('https://x.com', '/media/c/v/m.m3u8')).toThrow();
    expect(() => shareText('https://x.com', 'https://evil.example/content/abc')).toThrow();
    expect(() => shareText('https://x.com', 'content/abc')).toThrow();
    expect(() => shareText('https://x.com', '/content/abc?t=tok')).toThrow();
    expect(() => shareText('https://x.com', '//evil.example/content/abc')).toThrow();
    expect(() => shareText('https://x.com', '/\\evil.example/content/abc')).toThrow();
    expect(() => shareText('https://x.com', '/content/a b')).toThrow();
  });
});
