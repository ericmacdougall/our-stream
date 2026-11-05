// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildAppLink, isHandoffToken } from './magic-handoff.js';

const TOKEN = 'abcDEF0123456789._~-xyz';

describe('isHandoffToken', () => {
  it('accepts the app token alphabet at 20..200 characters', () => {
    expect(isHandoffToken(TOKEN)).toBe(true);
    expect(isHandoffToken('a'.repeat(20))).toBe(true);
    expect(isHandoffToken('a'.repeat(200))).toBe(true);
  });
  it('refuses short, long, empty and out-of-alphabet tokens', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'a'.repeat(19),
      'a'.repeat(201),
      `${TOKEN}&x=1`,
      `${TOKEN}/`,
      `${TOKEN} `,
      `${TOKEN}\n`,
      `${TOKEN}%41`,
      `${TOKEN}é`,
    ]) {
      expect(isHandoffToken(bad), String(bad)).toBe(false);
    }
  });
});

describe('buildAppLink', () => {
  it('builds the custom-scheme link with the page origin', () => {
    expect(buildAppLink(TOKEN, 'http://127.0.0.1:3100')).toBe(
      `ourstream://magic?token=${TOKEN}&server=http%3A%2F%2F127.0.0.1%3A3100`,
    );
    expect(buildAppLink(TOKEN, 'https://stream.example.org')).toBe(
      `ourstream://magic?token=${TOKEN}&server=https%3A%2F%2Fstream.example.org`,
    );
  });
  it('refuses a malformed token', () => {
    expect(buildAppLink('short', 'https://stream.example.org')).toBeNull();
    expect(buildAppLink(`${TOKEN}&server=https://evil.example`, 'https://a.example')).toBeNull();
  });
  it('refuses non-http(s) and non-origin values', () => {
    for (const bad of [
      'javascript:alert(1)',
      'ourstream://magic',
      'file:///etc/passwd',
      'data:text/html,x',
      'not a url',
      '',
      'https://a.example/path',
      'https://a.example/?x=1',
      'https://user:pw@a.example',
    ]) {
      expect(buildAppLink(TOKEN, bad), bad).toBeNull();
    }
  });
});
