// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { memoryStore } from './kv';
import {
  clearSession,
  loadLastServer,
  loadSession,
  pinServer,
  pinnedServer,
  saveLastServer,
  saveSession,
  unpinServer,
} from './session';

const server = { apiUrl: 'https://stream.example.com/api', webUrl: 'https://stream.example.com' };

describe('server pins', () => {
  it('pins and reads a server per email domain', async () => {
    const store = memoryStore();
    expect(await pinnedServer(store, 'example.com')).toBeNull();
    await pinServer(store, 'example.com', server);
    expect(await pinnedServer(store, 'example.com')).toEqual(server);
    expect(await pinnedServer(store, 'other.com')).toBeNull();
    await unpinServer(store, 'example.com');
    expect(await pinnedServer(store, 'example.com')).toBeNull();
  });
  it('ignores corrupted or insecure stored values', async () => {
    const store = memoryStore({ 'os.pins': '{broken' });
    expect(await pinnedServer(store, 'example.com')).toBeNull();
    const bad = memoryStore({
      'os.pins': JSON.stringify({
        'example.com': { apiUrl: 'http://x.com', webUrl: 'http://x.com' },
      }),
    });
    expect(await pinnedServer(bad, 'example.com')).toBeNull();
  });
});

describe('session persistence', () => {
  it('round-trips the signed-in server and secret, and clearing keeps the pins', async () => {
    const store = memoryStore();
    await pinServer(store, 'example.com', server);
    await saveSession(store, { server, secret: 's3cr3t-value' });
    expect(await loadSession(store)).toEqual({ server, secret: 's3cr3t-value' });
    // The secret lives under exactly one key, so logout can remove it without touching pins.
    const keys = Object.keys(store.dump()).filter((k) => store.dump()[k]?.includes('s3cr3t-value'));
    expect(keys).toEqual(['os.session']);
    await clearSession(store);
    expect(await loadSession(store)).toBeNull();
    expect(await pinnedServer(store, 'example.com')).toEqual(server);
  });
  it('treats a half-written session as absent', async () => {
    expect(await loadSession(memoryStore({ 'os.session': 'tok' }))).toBeNull();
    expect(await loadSession(memoryStore({ 'os.server': JSON.stringify(server) }))).toBeNull();
  });
});

describe('last server', () => {
  it('survives sign-out and rejects corrupted or insecure values', async () => {
    const store = memoryStore();
    expect(await loadLastServer(store)).toBeNull();
    await saveLastServer(store, server);
    await saveSession(store, { server, secret: 's' });
    await clearSession(store);
    expect(await loadLastServer(store)).toEqual(server);
    expect(await loadLastServer(memoryStore({ 'os.lastServer': '{' }))).toBeNull();
    expect(
      await loadLastServer(
        memoryStore({
          'os.lastServer': JSON.stringify({ apiUrl: 'http://x', webUrl: 'http://x' }),
        }),
      ),
    ).toBeNull();
  });
});
