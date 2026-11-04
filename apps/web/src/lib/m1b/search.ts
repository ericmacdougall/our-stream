// SPDX-License-Identifier: AGPL-3.0-only
// Search page state and snippet rendering. Snippet highlight ranges come from the server as UTF-16
// code-unit offsets; they are untrusted input and only ever become text and <mark> segments. Any
// malformed set (descending, overlapping, out of bounds, non-integer, empty) renders the whole
// snippet plain rather than guessing. Boundaries inside a surrogate pair are snapped outward so a
// lone surrogate never reaches the DOM.
import { EventTag } from '@our-stream/contracts';
import type { z } from 'zod';

export type Tag = z.output<typeof EventTag>;
export const TAGS: readonly Tag[] = EventTag.options;

export interface SnippetSegment {
  text: string;
  mark: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const QUERY_MAX = 200;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Moves an index off the middle of a surrogate pair: starts move back, ends move forward. */
function snap(text: string, index: number, kind: 'start' | 'end'): number {
  if (index <= 0 || index >= text.length) return index;
  const here = text.charCodeAt(index);
  const before = text.charCodeAt(index - 1);
  if (isLowSurrogate(here) && isHighSurrogate(before)) {
    return kind === 'start' ? index - 1 : index + 1;
  }
  return index;
}

export function snippetSegments(
  text: string,
  ranges: readonly (readonly [number, number])[],
): SnippetSegment[] {
  if (text === '') return [];
  const plain: SnippetSegment[] = [{ text, mark: false }];
  const normalised: [number, number][] = [];
  let cursor = 0;
  for (const range of ranges) {
    const [rawStart, rawEnd] = range;
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return plain;
    if (rawStart < 0 || rawEnd > text.length || rawStart >= rawEnd) return plain;
    const start = snap(text, rawStart, 'start');
    const end = snap(text, rawEnd, 'end');
    if (start < cursor) return plain;
    normalised.push([start, end]);
    cursor = end;
  }
  const out: SnippetSegment[] = [];
  let at = 0;
  for (const [start, end] of normalised) {
    if (start > at) out.push({ text: text.slice(at, start), mark: false });
    out.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

export interface SearchState {
  q: string;
  streamId?: string;
  tag?: Tag;
  /** Content id of the hit whose player is open (deep link). */
  play?: string;
  /** Position to open the player at, milliseconds. */
  tMs?: number;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** URL -> state; anything malformed is dropped so a tampered URL never reaches the API. */
export function parseSearchParams(
  params: Record<string, string | string[] | undefined>,
): SearchState {
  const state: SearchState = { q: (first(params['q']) ?? '').trim().slice(0, QUERY_MAX) };
  const streamId = first(params['streamId']);
  if (streamId && UUID_RE.test(streamId)) state.streamId = streamId;
  const tag = first(params['tag']);
  if (tag && (TAGS as readonly string[]).includes(tag)) state.tag = tag as Tag;
  const play = first(params['play']);
  if (play && UUID_RE.test(play)) state.play = play;
  const t = first(params['t']);
  if (t !== undefined && /^\d{1,12}$/.test(t)) state.tMs = Number(t);
  return state;
}

export function searchHref(state: SearchState): string {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.streamId) params.set('streamId', state.streamId);
  if (state.tag) params.set('tag', state.tag);
  if (state.play) params.set('play', state.play);
  if (state.tMs !== undefined) params.set('t', String(state.tMs));
  const qs = params.toString();
  return qs ? `/search?${qs}` : '/search';
}

/** "1000+" once the server's cap is reached. */
export function formatTotal(total: number, cap = 1000): string {
  return total >= cap ? `${cap}+` : String(total);
}
