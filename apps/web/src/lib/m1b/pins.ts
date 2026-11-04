// SPDX-License-Identifier: AGPL-3.0-only
// Which pin targets to offer for a clip. The contract knows one `pinned` aggregate per item, so the
// editor lists explicit targets and the server stays the judge: org-wide pins need owner, admin or
// announcer; a stream pin needs moderator/owner on that stream (or an org owner/admin) and the item
// must be addressed to that stream (otherwise `not_in_audience`). Offering only what the server
// would accept avoids `pin_forbidden` as the ordinary path.
export type OrgRole = 'owner' | 'admin' | 'announcer' | 'contributor' | 'member' | 'auditor';
export type StreamRole = 'viewer' | 'contributor' | 'moderator' | 'owner';

export interface PinTarget {
  /** null = org-wide. */
  streamId: string | null;
  label: string;
}

export function pinTargets(input: {
  orgRole: OrgRole | null;
  audience: readonly { type: string; streamId?: string }[];
  streams: readonly { id: string; name: string; myRole: StreamRole | null }[];
}): PinTarget[] {
  const out: PinTarget[] = [];
  const orgAdmin = input.orgRole === 'owner' || input.orgRole === 'admin';
  if (orgAdmin || input.orgRole === 'announcer') out.push({ streamId: null, label: '' });
  const seen = new Set<string>();
  for (const target of input.audience) {
    if (target.type !== 'stream' || !target.streamId || seen.has(target.streamId)) continue;
    seen.add(target.streamId);
    const stream = input.streams.find((s) => s.id === target.streamId);
    if (!stream) continue;
    const moderates = stream.myRole === 'moderator' || stream.myRole === 'owner';
    if (orgAdmin || moderates) out.push({ streamId: stream.id, label: stream.name });
  }
  return out;
}
