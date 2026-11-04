// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for the pure helpers: config fail-fast, CSRF/media tokens, playlist rewriting, cursors.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { enforceCsrf } from './auth.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { normalizeEmail } from './email.js';
import { cacheControlFor, classify, feedMedia, mediaPath, rewritePlaylist } from './media.js';
import {
  csrfTokenFor,
  csrfTokenValid,
  mediaTokenValid,
  parseMediaToken,
  signMediaToken,
} from './tokens.js';

const ORG = '0d2a2b1e-1b7e-4b2a-9d31-5f0c1d8e9a11';
const USER = '1d2a2b1e-1b7e-4b2a-9d31-5f0c1d8e9a22';
const CONTENT = '2d2a2b1e-1b7e-4b2a-9d31-5f0c1d8e9a33';
const VERSION = '3d2a2b1e-1b7e-4b2a-9d31-5f0c1d8e9a44';
const MEDIA_KEY_ID = '4d2a2b1e-1b7e-4b2a-9d31-5f0c1d8e9a55';
const SECRET = 'unit-test-secret-0123456789abcdefghijklmnop';

describe('config', () => {
  const prod = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://x',
    APP_BASE_URL: 'https://stream.example',
    SESSION_SECRET: 'a'.repeat(40),
    MEDIA_HMAC_SECRET: 'b'.repeat(40),
    S3_SECRET_KEY: 'real-secret',
  };
  it('refuses development default secrets in production', () => {
    expect(() => loadConfig({ ...prod, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/);
    expect(() =>
      loadConfig({ ...prod, MEDIA_HMAC_SECRET: 'dev-only-something-long-enough-to-pass-min' }),
    ).toThrow(/MEDIA_HMAC_SECRET/);
    expect(() => loadConfig({ ...prod, S3_SECRET_KEY: 'ourstream-dev-secret-only' })).toThrow(
      /S3_SECRET_KEY/,
    );
    expect(() => loadConfig({ ...prod, APP_BASE_URL: 'http://stream.example' })).toThrow(/https/);
    expect(loadConfig(prod).NODE_ENV).toBe('production');
  });
  it('accepts defaults outside production', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(c.S3_FORCE_PATH_STYLE).toBe(true);
    expect(c.SESSION_TTL_DAYS).toBe(30);
  });
});

describe('tokens', () => {
  it('csrf tokens are bound to the session id', () => {
    const t = csrfTokenFor(SECRET, 'session-a');
    expect(csrfTokenValid(SECRET, 'session-a', t)).toBe(true);
    expect(csrfTokenValid(SECRET, 'session-b', t)).toBe(false);
    expect(csrfTokenValid('other-secret-0123456789abcdefghijklmnop', 'session-a', t)).toBe(false);
    expect(csrfTokenValid(SECRET, 'session-a', '')).toBe(false);
  });
  it('media tokens verify only for the same user, org, version, key and before expiry', () => {
    const exp = 2_000_000_000;
    const token = signMediaToken(SECRET, {
      userId: USER,
      orgId: ORG,
      versionId: VERSION,
      mediaKeyId: MEDIA_KEY_ID,
      exp,
    });
    const parsed = parseMediaToken(token)!;
    expect(parsed).toMatchObject({ userId: USER, orgId: ORG, exp });
    expect(mediaTokenValid(SECRET, parsed, VERSION, MEDIA_KEY_ID, exp - 10)).toBe(true);
    expect(mediaTokenValid(SECRET, parsed, VERSION, MEDIA_KEY_ID, exp)).toBe(false); // expired
    expect(mediaTokenValid(SECRET, parsed, CONTENT, MEDIA_KEY_ID, exp - 10)).toBe(false); // other version
    expect(mediaTokenValid(SECRET, parsed, VERSION, ORG, exp - 10)).toBe(false); // rotated key
    expect(
      mediaTokenValid(SECRET, { ...parsed, userId: ORG }, VERSION, MEDIA_KEY_ID, exp - 10),
    ).toBe(false);
    expect(mediaTokenValid('x'.repeat(40), parsed, VERSION, MEDIA_KEY_ID, exp - 10)).toBe(false);
    expect(parseMediaToken('v1.not-a-uuid.1.sig')).toBeNull();
    expect(parseMediaToken(token.replace('v1.', 'v2.'))).toBeNull();
  });
});

describe('csrf enforcement', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://x', SESSION_SECRET: SECRET });
  const req = (over: Record<string, unknown>) =>
    ({
      method: 'POST',
      host: 'api.local',
      headers: {},
      auth: { sessionId: 'sid', viaCookie: true },
      ...over,
    }) as never;
  it('passes safe methods, bearer sessions, valid headers and trusted origins; blocks the rest', () => {
    expect(() => enforceCsrf(req({ method: 'GET' }), config)).not.toThrow();
    expect(() => enforceCsrf(req({ auth: null }), config)).not.toThrow();
    expect(() =>
      enforceCsrf(req({ auth: { sessionId: 'sid', viaCookie: false } }), config),
    ).not.toThrow();
    expect(() =>
      enforceCsrf(req({ headers: { 'x-csrf-token': csrfTokenFor(SECRET, 'sid') } }), config),
    ).not.toThrow();
    expect(() =>
      enforceCsrf(req({ headers: { origin: 'http://localhost:3000' } }), config),
    ).not.toThrow();
    expect(() =>
      enforceCsrf(req({ headers: { origin: 'https://api.local' } }), config),
    ).not.toThrow();
    expect(() =>
      enforceCsrf(req({ headers: { 'sec-fetch-site': 'same-origin' } }), config),
    ).not.toThrow();
    expect(() => enforceCsrf(req({}), config)).toThrow(/CSRF/);
    expect(() => enforceCsrf(req({ headers: { origin: 'https://evil.example' } }), config)).toThrow(
      /CSRF/,
    );
    expect(() => enforceCsrf(req({ headers: { origin: 'null' } }), config)).toThrow(/CSRF/);
    expect(() => enforceCsrf(req({ headers: { 'x-csrf-token': 'wrong' } }), config)).toThrow(
      /CSRF/,
    );
  });
});

describe('media paths and playlists', () => {
  const prefix = `orgs/${ORG}/content/${CONTENT}/versions/${VERSION}/derived/`;
  it('maps asset keys under the derived prefix to proxy paths and rejects anything else', () => {
    expect(mediaPath(ORG, CONTENT, VERSION, `${prefix}hls/master.m3u8`)).toBe(
      `/media/${CONTENT}/${VERSION}/hls/master.m3u8`,
    );
    expect(mediaPath(ORG, CONTENT, VERSION, 'poster.jpg')).toBe(
      `/media/${CONTENT}/${VERSION}/poster.jpg`,
    );
    expect(
      mediaPath(
        ORG,
        CONTENT,
        VERSION,
        `orgs/${ORG}/content/${CONTENT}/versions/other/derived/x.jpg`,
      ),
    ).toBeNull();
    expect(mediaPath(ORG, CONTENT, VERSION, '../original/secret')).toBeNull();
    expect(mediaPath(ORG, CONTENT, VERSION, null)).toBeNull();
    expect(feedMedia(ORG, CONTENT, VERSION, { poster: `${prefix}p.jpg` })).toBeNull(); // no master
    expect(
      feedMedia(ORG, CONTENT, VERSION, {
        hls: { master: `${prefix}hls/m.m3u8` },
        captions: { en: `${prefix}c/en.vtt` },
      }),
    ).toEqual({
      hls: `/media/${CONTENT}/${VERSION}/hls/m.m3u8`,
      poster: null,
      sprite: null,
      spriteVtt: null,
      captions: [{ lang: 'en', url: `/media/${CONTENT}/${VERSION}/c/en.vtt` }],
    });
  });
  it('rewrites playlists: relative kept, storage absolute mapped, foreign dropped, token appended', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="http://storage:8333/ourstream/' +
        prefix +
        'captions/en.m3u8"',
      'seg0.m4s',
      `http://storage:8333/ourstream/${prefix}hls/1080p/index.m3u8`,
      'https://evil.example/leak.m3u8',
      '../captions/en.m3u8',
      'bad name.m4s',
      '',
    ].join('\n');
    const plain = rewritePlaylist(input, CONTENT, VERSION, null);
    expect(plain.dropped).toBe(2);
    expect(plain.text.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      `#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/media/${CONTENT}/${VERSION}/captions/en.m3u8"`,
      'seg0.m4s',
      `/media/${CONTENT}/${VERSION}/hls/1080p/index.m3u8`,
      '../captions/en.m3u8',
      '',
    ]);
    expect(plain.text).not.toContain('storage:8333');
    const tokened = rewritePlaylist(input, CONTENT, VERSION, 'tok');
    expect(tokened.text).toContain('seg0.m4s?t=tok');
    expect(tokened.text).toContain('URI="init.mp4?t=tok"');
  });
  it('classifies cache policy by asset kind', () => {
    expect(cacheControlFor(classify('hls/master.m3u8'))).toBe('private, no-store');
    expect(cacheControlFor(classify('captions/en.vtt'))).toBe('private, no-store');
    expect(cacheControlFor(classify('hls/720p/seg1.m4s'))).toBe('private, max-age=60');
    expect(cacheControlFor(classify('poster.jpg'))).toBe('private, max-age=60');
  });
});

describe('cursor and email', () => {
  it('round-trips and rejects garbage', () => {
    const at = new Date('2026-11-03T12:00:00.000Z');
    const c = encodeCursor(at, CONTENT);
    expect(decodeCursor(c)).toEqual({ publishAt: at, id: CONTENT });
    expect(decodeCursor('not base64 json')).toBeNull();
    expect(
      decodeCursor(Buffer.from('["2026-11-03T12:00:00Z","x"]').toString('base64url')),
    ).toBeNull();
  });
  it('normalises email with NFKC and case folding', () => {
    expect(normalizeEmail(' Ｅric@Example.COM ')).toBe('eric@example.com');
  });
});
