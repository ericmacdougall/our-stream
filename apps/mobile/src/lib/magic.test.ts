// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { originOf, parseMagicLink } from './magic';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SERVER = 'https://stream.example.com';

describe('parseMagicLink', () => {
  it('reads the token and the normalised server origin from the app scheme', () => {
    expect(
      parseMagicLink(`ourstream://magic?token=${TOKEN}&server=${encodeURIComponent(SERVER)}`),
    ).toEqual({ token: TOKEN, server: SERVER });
    expect(
      parseMagicLink(
        `ourstream://auth/magic?token=${TOKEN}&server=${encodeURIComponent(`${SERVER}/some/path?x=1`)}`,
      ),
    ).toEqual({ token: TOKEN, server: SERVER });
    expect(
      parseMagicLink(
        `exp://192.168.1.2:8081/--/magic?token=${TOKEN}&server=http%3A%2F%2Flocalhost%3A3000`,
      ),
    ).toEqual({ token: TOKEN, server: 'http://localhost:3000' });
  });
  it('has a null server when absent or not an http(s) URL', () => {
    expect(parseMagicLink(`ourstream://magic?token=${TOKEN}`)).toEqual({
      token: TOKEN,
      server: null,
    });
    expect(parseMagicLink(`ourstream://magic?token=${TOKEN}&server=javascript:alert(1)`)).toEqual({
      token: TOKEN,
      server: null,
    });
    expect(parseMagicLink(`ourstream://magic?token=${TOKEN}&server=not a url`)).toEqual({
      token: TOKEN,
      server: null,
    });
  });
  it('never treats an https URL as an app link', () => {
    expect(parseMagicLink(`${SERVER}/magic?token=${TOKEN}&app=1`)).toBeNull();
    expect(parseMagicLink(`${SERVER}/auth/magic?token=${TOKEN}`)).toBeNull();
  });
  it('ignores other links and implausible tokens', () => {
    expect(parseMagicLink('ourstream://feed')).toBeNull();
    expect(parseMagicLink('ourstream://auth/magic?token=short')).toBeNull();
    expect(parseMagicLink('ourstream://auth/magic?token=' + 'x'.repeat(201))).toBeNull();
    expect(parseMagicLink('ourstream://auth/magic?token=has space' + TOKEN)).toBeNull();
    expect(parseMagicLink('')).toBeNull();
    expect(parseMagicLink('not a url')).toBeNull();
  });
});

describe('originOf', () => {
  it('normalises case, default ports, paths and rejects other schemes', () => {
    expect(originOf('HTTPS://Stream.Example.com:443/x')).toBe(SERVER);
    expect(originOf('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(originOf('ftp://x.com')).toBeNull();
    expect(originOf('nope')).toBeNull();
  });
});
