// SPDX-License-Identifier: Apache-2.0
// Magic-link tokens arriving by deep link are held in this memory slot, never in navigation state
// or storage, until the user explicitly signs in with them (magic screen). Consumed tokens are
// remembered for the process lifetime so a replayed initial URL cannot resubmit them.
import { magicTokenFromUrl } from './magic';

let pending: string | null = null;
const consumed = new Set<string>();

/** Records the token of a magic link URL; false when the URL is not one or was already used. */
export function offerMagicLink(url: string | null | undefined): boolean {
  if (!url) return false;
  const token = magicTokenFromUrl(url);
  if (!token || consumed.has(token)) return false;
  pending = token;
  return true;
}

export function hasPendingMagicLink(): boolean {
  return pending !== null;
}

/** Hands the token over once and marks it consumed. */
export function takeMagicToken(): string | null {
  const token = pending;
  pending = null;
  if (token) consumed.add(token);
  return token;
}

export function discardMagicLink(): void {
  pending = null;
}
