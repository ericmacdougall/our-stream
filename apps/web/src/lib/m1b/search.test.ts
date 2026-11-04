// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseSearchParams, searchHref, snippetSegments } from './search.js';

describe('snippetSegments: untrusted ranges become text and mark segments, never markup', () => {
  it('splits by UTF-16 code-unit offsets', () => {
    expect(
      snippetSegments('budget review for Q3', [
        [0, 6],
        [18, 20],
      ]),
    ).toEqual([
      { text: 'budget', mark: true },
      { text: ' review for ', mark: false },
      { text: 'Q3', mark: true },
    ]);
  });
  it('treats surrogate pairs as two code units like the server does', () => {
    // "😀 ok": the emoji is 2 code units, so "ok" is [3, 5).
    expect(snippetSegments('😀 ok', [[3, 5]])).toEqual([
      { text: '😀 ', mark: false },
      { text: 'ok', mark: true },
    ]);
  });
  it('renders the whole snippet plain when ranges overlap, descend, exceed the text or are inverted', () => {
    const text = 'abcdef';
    for (const bad of [
      [
        [0, 3],
        [2, 4],
      ],
      [
        [3, 4],
        [0, 1],
      ],
      [[0, 99]],
      [[4, 2]],
      [[-1, 2]],
      [[1.5, 3]],
    ] as [number, number][][]) {
      expect(snippetSegments(text, bad), JSON.stringify(bad)).toEqual([{ text, mark: false }]);
    }
  });
  it('handles empty ranges, empty text and a range ending exactly at the text length', () => {
    expect(snippetSegments('plain', [])).toEqual([{ text: 'plain', mark: false }]);
    expect(snippetSegments('', [])).toEqual([]);
    expect(snippetSegments('ab', [[1, 1]])).toEqual([{ text: 'ab', mark: false }]);
    expect(snippetSegments('ab', [[0, 2]])).toEqual([{ text: 'ab', mark: true }]);
    expect(snippetSegments('abc', [[2, 3]])).toEqual([
      { text: 'ab', mark: false },
      { text: 'c', mark: true },
    ]);
  });
  it('snaps a boundary that falls inside a surrogate pair to the code point so no U+FFFD renders', () => {
    // "a😀b": a=0, 😀=1..3, b=3. A range [2, 4) starts inside the emoji.
    const segments = snippetSegments('a😀b', [[2, 4]]);
    expect(segments).toEqual([
      { text: 'a', mark: false },
      { text: '😀b', mark: true },
    ]);
    for (const s of segments) expect(s.text).not.toContain('�');
    // A range ending inside the pair extends to include it.
    expect(snippetSegments('a😀b', [[0, 2]])).toEqual([
      { text: 'a😀', mark: true },
      { text: 'b', mark: false },
    ]);
  });
});

describe('search URL state', () => {
  it('reads q, filters and the deep-link player position', () => {
    expect(
      parseSearchParams({
        q: '  budget ',
        streamId: '11111111-1111-4111-8111-111111111111',
        tag: 'training',
        play: '22222222-2222-4222-8222-222222222222',
        t: '12500',
      }),
    ).toEqual({
      q: 'budget',
      streamId: '11111111-1111-4111-8111-111111111111',
      tag: 'training',
      play: '22222222-2222-4222-8222-222222222222',
      tMs: 12500,
    });
  });
  it('drops malformed values instead of forwarding them to the API', () => {
    const parsed = parseSearchParams({
      q: ['x'.repeat(300)],
      streamId: 'not-a-uuid',
      tag: 'nope',
      play: 'junk',
      t: '-5',
    });
    expect(parsed.q).toHaveLength(200);
    expect(parsed.streamId).toBeUndefined();
    expect(parsed.tag).toBeUndefined();
    expect(parsed.play).toBeUndefined();
    expect(parsed.tMs).toBeUndefined();
    expect(parseSearchParams({}).q).toBe('');
  });
  it('builds a same-origin href that round-trips', () => {
    const state = {
      q: 'a b',
      tag: 'onboarding' as const,
      play: '22222222-2222-4222-8222-222222222222',
      tMs: 3000,
    };
    const href = searchHref(state);
    expect(href.startsWith('/search?')).toBe(true);
    const params = Object.fromEntries(new URL(`http://x${href}`).searchParams);
    expect(parseSearchParams(params)).toEqual({ ...state });
    expect(searchHref({ q: '' })).toBe('/search');
  });
});
