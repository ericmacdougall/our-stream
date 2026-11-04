// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { FetchLike } from './discovery';
import { normaliseServerInput, probeServer } from './server';

function metaFetch(answering: Record<string, unknown>): FetchLike {
  return (async (input: string) => {
    const body = answering[input];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      url: input,
      redirected: false,
      headers: new Headers(),
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as unknown as Response;
  }) as FetchLike;
}
const META = { name: 'our-stream', version: '0.0.0', sourceUrl: 'https://x', commit: 'abc' };

describe('normaliseServerInput', () => {
  it('adds https when the scheme is missing and trims', () => {
    expect(normaliseServerInput('  stream.example.com ')).toBe('https://stream.example.com');
    expect(normaliseServerInput('https://X.com/')).toBe('https://x.com');
  });
  it('keeps loopback http only when allowed', () => {
    expect(normaliseServerInput('http://localhost:4107')).toBeNull();
    expect(normaliseServerInput('localhost:4107', { allowLoopbackHttp: true })).toBe(
      'https://localhost:4107',
    );
    expect(normaliseServerInput('http://localhost:4107', { allowLoopbackHttp: true })).toBe(
      'http://localhost:4107',
    );
  });
  it('rejects junk', () => {
    expect(normaliseServerInput('')).toBeNull();
    expect(normaliseServerInput('javascript:alert(1)')).toBeNull();
    expect(normaliseServerInput('https://u:p@x.com')).toBeNull();
  });
});

describe('probeServer', () => {
  it('prefers a bare API origin', async () => {
    const f = metaFetch({ 'https://x.com/v1/meta': META });
    expect(await probeServer('https://x.com', { fetch: f })).toEqual({
      apiUrl: 'https://x.com',
      webUrl: 'https://x.com',
    });
  });
  it('falls back to a web origin that proxies /api', async () => {
    const f = metaFetch({ 'https://x.com/api/v1/meta': META });
    expect(await probeServer('https://x.com', { fetch: f })).toEqual({
      apiUrl: 'https://x.com/api',
      webUrl: 'https://x.com',
    });
  });
  it('returns null when nothing answers or the answer is not our-stream', async () => {
    expect(await probeServer('https://x.com', { fetch: metaFetch({}) })).toBeNull();
    expect(
      await probeServer('https://x.com', {
        fetch: metaFetch({ 'https://x.com/v1/meta': { name: 'other' } }),
      }),
    ).toBeNull();
    const down = (async () => {
      throw new TypeError('down');
    }) as unknown as FetchLike;
    expect(await probeServer('https://x.com', { fetch: down })).toBeNull();
  });
});
