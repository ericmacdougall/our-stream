// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { magicTokenFromUrl } from './magic';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789';

describe('magicTokenFromUrl', () => {
  it('accepts the app scheme and the web link forms', () => {
    expect(magicTokenFromUrl(`ourstream://auth/magic?token=${TOKEN}`)).toBe(TOKEN);
    expect(magicTokenFromUrl(`ourstream://magic?token=${TOKEN}`)).toBe(TOKEN);
    expect(magicTokenFromUrl(`https://stream.example.com/auth/magic?token=${TOKEN}`)).toBe(TOKEN);
    expect(magicTokenFromUrl(`https://stream.example.com/magic?token=${TOKEN}&x=1`)).toBe(TOKEN);
    expect(magicTokenFromUrl(`exp://192.168.1.2:8081/--/auth/magic?token=${TOKEN}`)).toBe(TOKEN);
  });
  it('ignores other links and implausible tokens', () => {
    expect(magicTokenFromUrl('ourstream://feed')).toBeNull();
    expect(magicTokenFromUrl(`https://stream.example.com/content/abc?token=${TOKEN}`)).toBeNull();
    expect(magicTokenFromUrl('ourstream://auth/magic?token=short')).toBeNull();
    expect(magicTokenFromUrl('ourstream://auth/magic?token=' + 'x'.repeat(201))).toBeNull();
    expect(magicTokenFromUrl('ourstream://auth/magic?token=has space' + TOKEN)).toBeNull();
    expect(magicTokenFromUrl('')).toBeNull();
    expect(magicTokenFromUrl('not a url')).toBeNull();
  });
});
