// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { memoryStore } from './kv';
import {
  checkLink,
  consumeMagicLink,
  resolveSwitch,
  type ConsumeDeps,
  type SignInResult,
} from './magic-consume';
import { MAGIC_LINK_TTL_MS, loadMagicVerifier, startMagicRequest } from './magic-verifier';

const server = { apiUrl: 'https://stream.example.com/api', webUrl: 'https://stream.example.com' };
const link = { token: 'tok'.repeat(10), server: 'https://stream.example.com' };
const me = (id: string) => ({ user: { id } });
const crypto = {
  randomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => i + 1),
  sha256: (d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest()),
};

interface Calls {
  consume: { server: string; token: string; verifier: string }[];
}
async function setup(opts: {
  started?: boolean;
  result?: SignInResult<{ user: { id: string } }>;
  currentUserId?: string | null;
  now?: number;
}) {
  const store = memoryStore();
  if (opts.started !== false) await startMagicRequest(store, server, crypto, () => 0);
  const calls: Calls = { consume: [] };
  const deps: ConsumeDeps<{ user: { id: string } }> = {
    store,
    now: () => opts.now ?? 1,
    currentUserId: opts.currentUserId ?? null,
    consume: async (s, token, verifier) => {
      calls.consume.push({ server: s.apiUrl, token, verifier });
      return opts.result ?? { kind: 'ok', secret: 'sess', me: me('u1') };
    },
  };
  return { store, calls, deps };
}
const stillStored = async (store: ReturnType<typeof memoryStore>) =>
  (await loadMagicVerifier(store, { now: () => 1 })) !== null;

describe('checkLink', () => {
  const request = { verifier: 'v'.repeat(43), server };
  it('requires a request on this device and the same web origin', () => {
    expect(checkLink(link, null)).toEqual({ ok: false, reason: 'no_request' });
    expect(checkLink(link, request)).toEqual({ ok: true, request });
    expect(checkLink({ ...link, server: 'https://evil.example' }, request)).toEqual({
      ok: false,
      reason: 'wrong_server',
    });
    expect(checkLink({ ...link, server: null }, request)).toEqual({
      ok: false,
      reason: 'wrong_server',
    });
    // Same host on another scheme or port is a different origin.
    expect(checkLink({ ...link, server: 'http://stream.example.com' }, request).ok).toBe(false);
    expect(checkLink({ ...link, server: 'https://stream.example.com:8443' }, request).ok).toBe(
      false,
    );
  });
});

describe('consumeMagicLink', () => {
  it('refuses without a stored verifier and never calls the server', async () => {
    const { deps, calls } = await setup({ started: false });
    expect(await consumeMagicLink(link, deps)).toEqual({ kind: 'blocked', reason: 'no_request' });
    expect(calls.consume).toHaveLength(0);
  });
  it('refuses an expired verifier', async () => {
    const { deps, calls } = await setup({ now: MAGIC_LINK_TTL_MS + 1 });
    expect(await consumeMagicLink(link, deps)).toEqual({ kind: 'blocked', reason: 'no_request' });
    expect(calls.consume).toHaveLength(0);
  });
  it('refuses a link naming another server, keeps the verifier, sends nothing', async () => {
    const { deps, calls, store } = await setup({});
    const out = await consumeMagicLink({ ...link, server: 'https://evil.example' }, deps);
    expect(out).toEqual({ kind: 'blocked', reason: 'wrong_server' });
    expect(calls.consume).toHaveLength(0);
    expect(await stillStored(store)).toBe(true);
  });
  it('signs in when signed out, sending the stored verifier to the pinned server, then deletes it', async () => {
    const { deps, calls, store } = await setup({});
    const stored = (await loadMagicVerifier(store, { now: () => 1 }))!;
    const out = await consumeMagicLink(link, deps);
    expect(out).toMatchObject({ kind: 'signedIn', secret: 'sess', replacesSession: false });
    expect(calls.consume).toEqual([
      { server: server.apiUrl, token: link.token, verifier: stored.verifier },
    ]);
    expect(await stillStored(store)).toBe(false);
  });
  it('same account while signed in replaces the session without a prompt', async () => {
    const { deps } = await setup({ currentUserId: 'u1' });
    expect(await consumeMagicLink(link, deps)).toMatchObject({
      kind: 'signedIn',
      replacesSession: true,
    });
  });
  it('asks Switch or Keep for a different account', async () => {
    const { deps, store } = await setup({ currentUserId: 'someone-else' });
    expect(await consumeMagicLink(link, deps)).toMatchObject({
      kind: 'confirmSwitch',
      secret: 'sess',
    });
    expect(await stillStored(store)).toBe(false);
  });
  it('a definite refusal (bad, used or mismatched token) deletes the verifier and signs nothing in', async () => {
    const { deps, store } = await setup({ result: { kind: 'refused' } });
    expect(await consumeMagicLink(link, deps)).toEqual({ kind: 'refused' });
    expect(await stillStored(store)).toBe(false);
  });
  it('a replayed link cannot be consumed twice: the first attempt spends the verifier', async () => {
    const { deps, calls } = await setup({});
    expect((await consumeMagicLink(link, deps)).kind).toBe('signedIn');
    expect(await consumeMagicLink(link, deps)).toEqual({ kind: 'blocked', reason: 'no_request' });
    expect(calls.consume).toHaveLength(1);
  });
  it('keeps the verifier on network loss so the same link retries within the TTL', async () => {
    const { deps, store, calls } = await setup({ result: { kind: 'network' } });
    expect(await consumeMagicLink(link, deps)).toEqual({ kind: 'network' });
    expect(await stillStored(store)).toBe(true);
    const retry = {
      ...deps,
      consume: async () => ({ kind: 'ok' as const, secret: 's2', me: me('u1') }),
    };
    expect(await consumeMagicLink(link, retry)).toMatchObject({ kind: 'signedIn', secret: 's2' });
    expect(calls.consume).toHaveLength(1);
  });
});

describe('resolveSwitch', () => {
  const incoming = { server, secret: 'new', me: me('u2') };
  const recorder = () => {
    const log: string[] = [];
    return {
      log,
      deps: {
        logoutCurrent: async () => void log.push('logout'),
        signIn: async (_s: typeof server, secret: string) => void log.push(`signIn:${secret}`),
        revokeIncoming: async (_s: typeof server, secret: string) =>
          void log.push(`revoke:${secret}`),
      },
    };
  };
  it('Switch signs the current session out then signs the new one in', async () => {
    const r = recorder();
    await resolveSwitch('switch', incoming, r.deps);
    expect(r.log).toEqual(['logout', 'signIn:new']);
  });
  it('Keep revokes the link session and leaves the current session alone', async () => {
    const r = recorder();
    await resolveSwitch('keep', incoming, r.deps);
    expect(r.log).toEqual(['revoke:new']);
  });
});
