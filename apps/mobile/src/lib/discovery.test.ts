// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_MAX_BYTES,
  discoverServer,
  emailDomain,
  parseDiscoveryDocument,
  hostRelation,
  validateServerUrl,
  type FetchLike,
} from './discovery';

type FakeResponse = {
  status: number;
  url?: string;
  redirected?: boolean;
  headers?: Record<string, string>;
  body?: string;
};

function fakeFetch(
  routes: Record<string, FakeResponse | (() => never)>,
  seen: string[] = [],
): FetchLike {
  return (async (input: string, init?: RequestInit) => {
    seen.push(input);
    const r = routes[input];
    if (!r)
      return {
        ok: false,
        status: 404,
        url: input,
        redirected: false,
        headers: new Headers(),
        text: async () => '',
      } as unknown as Response;
    if (typeof r === 'function') r();
    const res = r as FakeResponse;
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      url: res.url ?? input,
      redirected: res.redirected ?? false,
      headers: new Headers(res.headers ?? {}),
      text: async () => res.body ?? '',
    } as unknown as Response;
  }) as FetchLike;
}

const GOOD = JSON.stringify({ version: 1, apiUrl: 'https://stream.example.com/api' });
const WELL_KNOWN = 'https://example.com/.well-known/our-stream.json';

describe('emailDomain', () => {
  it('lowercases the host part of an address', () => {
    expect(emailDomain('Alice@Example.COM')).toBe('example.com');
    expect(emailDomain('  bob@sub.example.org ')).toBe('sub.example.org');
  });
  it('rejects malformed addresses, IP literals and dotless hosts', () => {
    for (const bad of [
      'nope',
      'a@b@c',
      'a@[1.2.3.4]',
      'a@1.2.3.4',
      'a@localhost',
      'a@',
      '@x.com',
      'a@ex ample.com',
      'a@-example.com',
      'a@example.com.',
      'a@printer.local',
      'a@corp.internal',
      'a@bücher.example',
    ]) {
      expect(emailDomain(bad)).toBeNull();
    }
  });
});

describe('validateServerUrl', () => {
  it('accepts https origins and paths, normalising case and trailing slash', () => {
    expect(validateServerUrl('https://Stream.Example.com/')).toBe('https://stream.example.com');
    expect(validateServerUrl('https://x.com/api/')).toBe('https://x.com/api');
    expect(validateServerUrl('https://x.com:8443')).toBe('https://x.com:8443');
  });
  it('rejects http unless loopback in a dev build', () => {
    expect(validateServerUrl('http://stream.example.com')).toBeNull();
    expect(validateServerUrl('http://localhost:4107')).toBeNull();
    expect(validateServerUrl('http://localhost:4107', { allowLoopbackHttp: true })).toBe(
      'http://localhost:4107',
    );
    expect(validateServerUrl('http://127.0.0.1:4107', { allowLoopbackHttp: true })).toBe(
      'http://127.0.0.1:4107',
    );
    expect(validateServerUrl('http://10.0.0.5:4107', { allowLoopbackHttp: true })).toBeNull();
  });
  it('rejects credentials, query, fragment, other schemes and junk', () => {
    for (const bad of [
      'https://user:pw@x.com',
      'https://x.com/?q=1',
      'https://x.com/#f',
      'javascript:alert(1)',
      'ftp://x.com',
      'x.com',
      '',
      'https://',
      'https://x.com/a b',
    ]) {
      expect(validateServerUrl(bad)).toBeNull();
    }
  });
});

describe('parseDiscoveryDocument', () => {
  it('returns apiUrl and derives webUrl from an /api suffix', () => {
    expect(parseDiscoveryDocument(GOOD)).toEqual({
      ok: true,
      server: { apiUrl: 'https://stream.example.com/api', webUrl: 'https://stream.example.com' },
    });
  });
  it('uses apiUrl as webUrl when there is no /api suffix and honours an explicit webUrl', () => {
    expect(
      parseDiscoveryDocument(JSON.stringify({ version: 1, apiUrl: 'https://api.example.com' })),
    ).toEqual({
      ok: true,
      server: { apiUrl: 'https://api.example.com', webUrl: 'https://api.example.com' },
    });
    expect(
      parseDiscoveryDocument(
        JSON.stringify({
          version: 1,
          apiUrl: 'https://api.example.com',
          webUrl: 'https://go.example.com/',
        }),
      ),
    ).toEqual({
      ok: true,
      server: { apiUrl: 'https://api.example.com', webUrl: 'https://go.example.com' },
    });
  });
  it('fails closed on bad versions, missing or insecure urls and non-objects', () => {
    expect(parseDiscoveryDocument('not json')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDiscoveryDocument('[]')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseDiscoveryDocument(JSON.stringify({ version: 2, apiUrl: 'https://x.com' }))).toEqual(
      { ok: false, reason: 'invalid' },
    );
    expect(parseDiscoveryDocument(JSON.stringify({ version: 1 }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(parseDiscoveryDocument(JSON.stringify({ version: 1, apiUrl: 'http://x.com' }))).toEqual({
      ok: false,
      reason: 'insecure_server',
    });
    expect(
      parseDiscoveryDocument(
        JSON.stringify({ version: 1, apiUrl: 'https://x.com', webUrl: 'http://x.com' }),
      ),
    ).toEqual({ ok: false, reason: 'insecure_server' });
    expect(
      parseDiscoveryDocument(JSON.stringify({ version: 1, apiUrl: 'https://u:p@x.com' })),
    ).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('discoverServer', () => {
  it('fetches only the well-known document on the email domain over https', async () => {
    const seen: string[] = [];
    const result = await discoverServer('alice@Example.com', {
      fetch: fakeFetch({ [WELL_KNOWN]: { status: 200, body: GOOD } }, seen),
    });
    expect(seen).toEqual([WELL_KNOWN]);
    expect(result).toEqual({
      ok: true,
      domain: 'example.com',
      server: { apiUrl: 'https://stream.example.com/api', webUrl: 'https://stream.example.com' },
    });
  });
  it('refuses a bad address without any network call', async () => {
    const seen: string[] = [];
    expect(await discoverServer('nope', { fetch: fakeFetch({}, seen) })).toEqual({
      ok: false,
      reason: 'bad_email',
    });
    expect(seen).toEqual([]);
  });
  it('fails closed when the document was served from another host or via a redirect', async () => {
    const f = fakeFetch({
      [WELL_KNOWN]: {
        status: 200,
        body: GOOD,
        url: 'https://evil.example.net/.well-known/our-stream.json',
      },
    });
    expect(await discoverServer('a@example.com', { fetch: f })).toEqual({
      ok: false,
      reason: 'redirected',
    });
    const g = fakeFetch({ [WELL_KNOWN]: { status: 200, body: GOOD, redirected: true } });
    expect(await discoverServer('a@example.com', { fetch: g })).toEqual({
      ok: false,
      reason: 'redirected',
    });
    // Same host, different path or scheme, or a fetch that cannot say where the body came from.
    const i = fakeFetch({
      [WELL_KNOWN]: { status: 200, body: GOOD, url: 'https://example.com/other.json' },
    });
    expect(await discoverServer('a@example.com', { fetch: i })).toEqual({
      ok: false,
      reason: 'redirected',
    });
    const j = fakeFetch({ [WELL_KNOWN]: { status: 200, body: GOOD, url: '' } });
    expect(await discoverServer('a@example.com', { fetch: j })).toEqual({
      ok: false,
      reason: 'redirected',
    });
    const h = fakeFetch({
      [WELL_KNOWN]: { status: 302, headers: { location: 'https://evil.example.net/x' } },
    });
    expect(await discoverServer('a@example.com', { fetch: h })).toEqual({
      ok: false,
      reason: 'redirected',
    });
  });
  it('maps 404, oversize, invalid, insecure and network failures to reasons', async () => {
    expect(await discoverServer('a@example.com', { fetch: fakeFetch({}) })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    const big = fakeFetch({
      [WELL_KNOWN]: {
        status: 200,
        headers: { 'content-length': String(DISCOVERY_MAX_BYTES + 1) },
        body: GOOD,
      },
    });
    expect(await discoverServer('a@example.com', { fetch: big })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    const bigBody = fakeFetch({
      [WELL_KNOWN]: {
        status: 200,
        body:
          '{"version":1,"apiUrl":"https://x.com","pad":"' + 'x'.repeat(DISCOVERY_MAX_BYTES) + '"}',
      },
    });
    expect(await discoverServer('a@example.com', { fetch: bigBody })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(
      await discoverServer('a@example.com', {
        fetch: fakeFetch({ [WELL_KNOWN]: { status: 200, body: '{' } }),
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(
      await discoverServer('a@example.com', {
        fetch: fakeFetch({
          [WELL_KNOWN]: {
            status: 200,
            body: JSON.stringify({ version: 1, apiUrl: 'http://x.com' }),
          },
        }),
      }),
    ).toEqual({ ok: false, reason: 'insecure_server' });
    const down = fakeFetch({
      [WELL_KNOWN]: () => {
        throw new TypeError('Network request failed');
      },
    });
    expect(await discoverServer('a@example.com', { fetch: down })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    const slow = fakeFetch({
      [WELL_KNOWN]: () => {
        throw Object.assign(new Error('x'), { name: 'AbortError' });
      },
    });
    expect(await discoverServer('a@example.com', { fetch: slow })).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });
});

describe('hostRelation', () => {
  it('classifies the server host against the email domain', () => {
    expect(hostRelation('example.com', 'https://example.com/api')).toBe('same');
    expect(hostRelation('example.com', 'https://stream.example.com')).toBe('subdomain');
    expect(hostRelation('example.com', 'https://notexample.com')).toBe('other');
    expect(hostRelation('example.com', 'https://acme.ourstream.app')).toBe('other');
    expect(hostRelation('example.com', 'nonsense')).toBe('other');
  });
});
