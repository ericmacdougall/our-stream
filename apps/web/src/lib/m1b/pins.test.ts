// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { pinTargets } from './pins.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const streams = [
  { id: S1, name: 'Sales', myRole: 'moderator' as const },
  { id: S2, name: 'Ops', myRole: 'viewer' as const },
];
const audience = [
  { type: 'stream' as const, streamId: S1 },
  { type: 'stream' as const, streamId: S2 },
  { type: 'everyone' as const },
];

describe('pinTargets: only the pins the server would accept are offered', () => {
  it('offers org-wide to owner/admin/announcer only', () => {
    for (const role of ['owner', 'admin', 'announcer'] as const) {
      expect(pinTargets({ orgRole: role, audience: [], streams }).map((t) => t.streamId)).toEqual([
        null,
      ]);
    }
    for (const role of ['contributor', 'member', 'auditor', null] as const) {
      expect(pinTargets({ orgRole: role, audience: [], streams })).toEqual([]);
    }
  });
  it('offers an audience stream when the caller moderates it (or is an org admin)', () => {
    const member = pinTargets({ orgRole: 'member', audience, streams });
    expect(member.map((t) => t.streamId)).toEqual([S1]);
    expect(member[0]?.label).toBe('Sales');
    const admin = pinTargets({ orgRole: 'admin', audience, streams });
    expect(admin.map((t) => t.streamId)).toEqual([null, S1, S2]);
  });
  it('never offers a stream the item is not addressed to, even for an admin', () => {
    expect(
      pinTargets({ orgRole: 'admin', audience: [{ type: 'everyone' }], streams }).map(
        (t) => t.streamId,
      ),
    ).toEqual([null]);
  });
  it('skips audience streams the caller cannot see in the stream list', () => {
    expect(
      pinTargets({
        orgRole: 'member',
        audience: [{ type: 'stream', streamId: '33333333-3333-4333-8333-333333333333' }],
        streams,
      }),
    ).toEqual([]);
  });
});
