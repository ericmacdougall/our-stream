// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { memoryStore } from './kv';
import {
  MAGIC_LINK_TTL_MS,
  base64url,
  challengeOf,
  clearMagicVerifier,
  loadMagicVerifier,
  startMagicRequest,
  type MagicCrypto,
} from './magic-verifier';

const server = { apiUrl: 'https://stream.example.com/api', webUrl: 'https://stream.example.com' };
const crypto: MagicCrypto = {
  randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255),
  sha256: (d) => new Uint8Array(createHash('sha256').update(d).digest()),
};

describe('base64url', () => {
  it('matches Node for every length without padding', () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect(base64url(b)).toBe(Buffer.from(b).toString('base64url'));
    }
    expect(base64url(Uint8Array.from([251, 255, 254]))).toBe('-__-');
  });
});

describe('magic verifier', () => {
  it('stores a 43-char verifier and sends only SHA-256 of it as a 43-char challenge', async () => {
    const store = memoryStore();
    const { clientChallenge } = await startMagicRequest(store, server, crypto, () => 1000);
    expect(clientChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const v = (await loadMagicVerifier(store, { now: () => 1000 }))!;
    expect(v.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(v.server).toEqual(server);
    expect(clientChallenge).toBe(
      createHash('sha256').update(v.verifier, 'utf8').digest('base64url'),
    );
    expect(clientChallenge).not.toContain(v.verifier);
    expect(await challengeOf(v.verifier, crypto)).toBe(clientChallenge);
  });
  it('replaces the previous verifier on a new request', async () => {
    const store = memoryStore();
    let n = 0;
    const c: MagicCrypto = {
      ...crypto,
      randomBytes: (len) => Uint8Array.from({ length: len }, () => ++n),
    };
    await startMagicRequest(store, server, c);
    const first = (await loadMagicVerifier(store))!.verifier;
    await startMagicRequest(store, server, c);
    expect((await loadMagicVerifier(store))!.verifier).not.toBe(first);
  });
  it('expires with the link TTL and deletes the expired value', async () => {
    const store = memoryStore();
    await startMagicRequest(store, server, crypto, () => 0);
    expect(await loadMagicVerifier(store, { now: () => MAGIC_LINK_TTL_MS - 1 })).not.toBeNull();
    expect(await loadMagicVerifier(store, { now: () => MAGIC_LINK_TTL_MS })).toBeNull();
    expect(store.dump()['os.magicVerifier']).toBeUndefined();
  });
  it('treats corrupt, tampered or insecure values as absent and removes them', async () => {
    const bad = [
      '{broken',
      JSON.stringify({ verifier: 'short', server, at: 0 }),
      JSON.stringify({
        verifier: 'a'.repeat(43),
        server: { apiUrl: 'http://x.com', webUrl: 'http://x.com' },
        at: 0,
      }),
      JSON.stringify({ verifier: 'a'.repeat(43), server, at: 'now' }),
      JSON.stringify({ verifier: 'a'.repeat(43), server, at: 5000 }), // from the future
    ];
    for (const raw of bad) {
      const store = memoryStore({ 'os.magicVerifier': raw });
      expect(await loadMagicVerifier(store, { now: () => 0 })).toBeNull();
      expect(store.dump()['os.magicVerifier']).toBeUndefined();
    }
  });
  it('clears on request', async () => {
    const store = memoryStore();
    await startMagicRequest(store, server, crypto);
    await clearMagicVerifier(store);
    expect(await loadMagicVerifier(store)).toBeNull();
  });
});
