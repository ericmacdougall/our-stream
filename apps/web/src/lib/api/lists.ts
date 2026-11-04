// SPDX-License-Identifier: AGPL-3.0-only
// The hand-typed M1a paths describe list routes (/v1/streams, /v1/members, /v1/streams/{id}/members)
// as `{ items: T[] }`, but the API emits a bare array for them (M1a and M1b alike). Until the two are
// aligned, every list consumer goes through this helper and accepts either shape; anything else
// (an error body, undefined) is an empty list rather than a crash.
export function listItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object' && 'items' in data) {
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items)) return items as T[];
  }
  return [];
}
