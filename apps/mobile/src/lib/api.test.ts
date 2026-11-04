// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createApi, logoutBestEffort, routeOf, splitSignIn, TRANSPORT_HEADER } from './api';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
}

function harness(status: number | ((route: string) => number), body: unknown = { ok: true }) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    seen.push({
      url: req.url,
      method: req.method,
      headers,
      credentials: init?.credentials ?? req.credentials,
    });
    const code = typeof status === 'function' ? status(routeOf(req.url)) : status;
    return new Response(
      JSON.stringify(
        code >= 400
          ? { error: { code: typeof body === 'string' ? body : 'x', message: 'm' } }
          : body,
      ),
      {
        status: code,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  return { seen, fetchImpl };
}

describe('createApi', () => {
  it('asks for the bearer transport on sign-in only and never sends cookies', async () => {
    const { seen, fetchImpl } = harness(200, { user: {} });
    const api = createApi({ apiUrl: 'https://x.com/api', fetch: fetchImpl });
    await api.POST('/v1/auth/login', { body: { email: 'a@example.com', password: 'pw' } });
    await api.GET('/v1/feed');
    expect(seen[0]?.url).toBe('https://x.com/api/v1/auth/login');
    expect(seen[0]?.headers[TRANSPORT_HEADER]).toBe('bearer');
    expect(seen[0]?.credentials).toBe('omit');
    expect(seen[1]?.headers[TRANSPORT_HEADER]).toBeUndefined();
    expect(seen[1]?.headers['authorization']).toBeUndefined();
    expect(seen[1]?.credentials).toBe('omit');
  });
  it('sends the session as a bearer header once signed in', async () => {
    const { seen, fetchImpl } = harness(200, { items: [] });
    const api = createApi({ apiUrl: 'https://x.com', secret: 'sess-1', fetch: fetchImpl });
    await api.GET('/v1/feed');
    expect(seen[0]?.headers['authorization']).toBe('Bearer sess-1');
  });
  it('reports a 401 outside sign-in exactly once per response, not for sign-in failures', async () => {
    let unauthorized = 0;
    const { fetchImpl } = harness(401);
    const api = createApi({
      apiUrl: 'https://x.com',
      secret: 's',
      fetch: fetchImpl,
      onUnauthorized: () => unauthorized++,
    });
    await api.POST('/v1/auth/login', { body: { email: 'a@example.com', password: 'pw' } });
    expect(unauthorized).toBe(0);
    await api.GET('/v1/feed');
    expect(unauthorized).toBe(1);
  });
  it('reports not_member on 403 and ignores other 403 codes', async () => {
    const codes: string[] = [];
    const a = createApi({
      apiUrl: 'https://x.com',
      secret: 's',
      fetch: harness(403, 'not_member').fetchImpl,
      onForbidden: (c) => codes.push(c),
    });
    await a.GET('/v1/feed');
    const b = createApi({
      apiUrl: 'https://x.com',
      secret: 's',
      fetch: harness(403, 'role_forbidden').fetchImpl,
      onForbidden: (c) => codes.push(c),
    });
    await b.GET('/v1/feed');
    expect(codes).toEqual(['not_member']);
  });
});

describe('logoutBestEffort', () => {
  it('posts the logout and swallows failures', async () => {
    const { seen, fetchImpl } = harness(200);
    await logoutBestEffort(createApi({ apiUrl: 'https://x.com', secret: 's', fetch: fetchImpl }));
    expect(seen.map((s) => [s.method, routeOf(s.url)])).toEqual([['POST', '/v1/auth/logout']]);
    const down: typeof fetch = async () => {
      throw new TypeError('offline');
    };
    await expect(
      logoutBestEffort(createApi({ apiUrl: 'https://x.com', secret: 's', fetch: down })),
    ).resolves.toBeUndefined();
  });
});

describe('splitSignIn', () => {
  it('separates the secret from the profile and never leaves it inside me', () => {
    type Resp = { user: { id: string }; csrfToken: string; sessionToken?: string };
    const out = splitSignIn<Resp>({ user: { id: 'u' }, csrfToken: 'c', sessionToken: 'sess' });
    expect(out.secret).toBe('sess');
    expect(out.me).toEqual({ user: { id: 'u' }, csrfToken: 'c' });
    expect('sessionToken' in out.me).toBe(false);
    expect(splitSignIn<Resp>({ user: { id: 'u' }, csrfToken: 'c' }).secret).toBeNull();
    expect(
      splitSignIn<Resp>({ user: { id: 'u' }, csrfToken: 'c', sessionToken: '' }).secret,
    ).toBeNull();
  });
});

describe('routeOf', () => {
  it('strips a server path prefix', () => {
    expect(routeOf('https://x.com/api/v1/feed?cursor=1')).toBe('/v1/feed');
    expect(routeOf('https://x.com/v1/me')).toBe('/v1/me');
  });
});
