// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { resolveStartup } from './startup';

const notices = { sessionExpired: 'EXPIRED', generic: 'GENERIC', offline: 'OFFLINE' };
const stored = { secret: 's' };
const run = (fetchMe: () => Promise<{ data?: { id: string }; status: number }>, has = true) =>
  resolveStartup({ load: async () => (has ? stored : null), fetchMe, notices });

describe('resolveStartup', () => {
  it('signs out quietly when nothing is stored, without calling the server', async () => {
    let called = false;
    const r = await run(async () => {
      called = true;
      return { status: 200 };
    }, false);
    expect(r).toEqual({ kind: 'signedOut', notice: null, drop: false });
    expect(called).toBe(false);
  });
  it('signs in with the stored session when /v1/me answers', async () => {
    expect(await run(async () => ({ data: { id: 'u1' }, status: 200 }))).toEqual({
      kind: 'signedIn',
      stored,
      me: { id: 'u1' },
    });
  });
  it('drops the session on 401', async () => {
    expect(await run(async () => ({ status: 401 }))).toEqual({
      kind: 'signedOut',
      notice: 'EXPIRED',
      drop: true,
    });
  });
  it('drops the session on any 403, including proxy or unknown codes (never left loading)', async () => {
    expect(await run(async () => ({ status: 403 }))).toEqual({
      kind: 'signedOut',
      notice: 'EXPIRED',
      drop: true,
    });
  });
  it('signs out with a notice on 5xx but keeps the stored session', async () => {
    for (const status of [500, 502, 503]) {
      expect(await run(async () => ({ status }))).toEqual({
        kind: 'signedOut',
        notice: 'GENERIC',
        drop: false,
      });
    }
  });
  it('signs out with an offline notice when the server is unreachable, keeping the session', async () => {
    expect(
      await run(async () => {
        throw new TypeError('Network request failed');
      }),
    ).toEqual({ kind: 'signedOut', notice: 'OFFLINE', drop: false });
  });
});
