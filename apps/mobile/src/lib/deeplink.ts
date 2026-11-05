// SPDX-License-Identifier: Apache-2.0
// Magic-link tokens arriving by deep link are held in this memory slot, never in navigation state
// or storage, until the user explicitly signs in with them (magic screen). Consumed tokens are
// remembered for the process lifetime so a replayed initial URL cannot resubmit them.
import { parseMagicLink, type MagicLink } from './magic';

let pending: MagicLink | null = null;
const consumed = new Set<string>();

/** Records the magic link in a URL; false when the URL is not one or its token was already used. */
export function offerMagicLink(url: string | null | undefined): boolean {
  if (!url) return false;
  const link = parseMagicLink(url);
  if (!link || consumed.has(link.token)) return false;
  pending = link;
  return true;
}

export function hasPendingMagicLink(): boolean {
  return pending !== null;
}

/** Hands the link over once and marks its token consumed. */
export function takeMagicLink(): MagicLink | null {
  const link = pending;
  pending = null;
  if (link) consumed.add(link.token);
  return link;
}

/** After a network failure the server never saw the token: allow the same link to be retried. */
export function restoreMagicLink(link: MagicLink): void {
  consumed.delete(link.token);
  pending = link;
}

export function discardMagicLink(): void {
  pending = null;
}
