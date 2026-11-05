// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789';
const URL_ = `ourstream://magic?token=${TOKEN}&server=https%3A%2F%2Fstream.example.com`;

// The slot is module state: load a fresh copy per test.
async function fresh() {
  vi.resetModules();
  return import('./deeplink');
}
beforeEach(() => vi.resetModules());

describe('magic link memory slot', () => {
  it('holds the link until taken, then refuses a replay of the same token', async () => {
    const d = await fresh();
    expect(d.offerMagicLink(URL_)).toBe(true);
    expect(d.hasPendingMagicLink()).toBe(true);
    expect(d.takeMagicLink()).toEqual({ token: TOKEN, server: 'https://stream.example.com' });
    expect(d.hasPendingMagicLink()).toBe(false);
    expect(d.offerMagicLink(URL_)).toBe(false); // replayed initial URL
    expect(d.takeMagicLink()).toBeNull();
  });
  it('ignores non-links and https URLs', async () => {
    const d = await fresh();
    expect(d.offerMagicLink(null)).toBe(false);
    expect(d.offerMagicLink('ourstream://feed')).toBe(false);
    expect(d.offerMagicLink(`https://stream.example.com/magic?token=${TOKEN}&app=1`)).toBe(false);
    expect(d.hasPendingMagicLink()).toBe(false);
  });
  it('lets a link be retried after a network failure, and discard drops it', async () => {
    const d = await fresh();
    d.offerMagicLink(URL_);
    const link = d.takeMagicLink()!;
    d.restoreMagicLink(link);
    expect(d.hasPendingMagicLink()).toBe(true);
    expect(d.takeMagicLink()).toEqual(link);
    d.offerMagicLink(URL_);
    d.discardMagicLink();
    expect(d.hasPendingMagicLink()).toBe(false);
  });
});
