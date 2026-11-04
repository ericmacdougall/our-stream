// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { formatTimestamp, snippetSegments } from './snippets';

describe('snippetSegments', () => {
  it('applies UTF-16 ranges directly, keeping astral characters whole', () => {
    // "Hello 🎉 world": the emoji is one code point but two UTF-16 units at [6, 8).
    expect(snippetSegments('Hello 🎉 world', [[6, 8]])).toEqual([
      { text: 'Hello ', highlight: false },
      { text: '🎉', highlight: true },
      { text: ' world', highlight: false },
    ]);
    expect(snippetSegments('🎉 budget 🎉 talk', [[3, 9]])).toEqual([
      { text: '🎉 ', highlight: false },
      { text: 'budget', highlight: true },
      { text: ' 🎉 talk', highlight: false },
    ]);
  });
  it('never splits a surrogate pair even if a range does', () => {
    expect(snippetSegments('a🎉b', [[1, 2]])).toEqual([
      { text: 'a', highlight: false },
      { text: '🎉', highlight: true },
      { text: 'b', highlight: false },
    ]);
    expect(snippetSegments('a🎉b', [[2, 4]])).toEqual([
      { text: 'a', highlight: false },
      { text: '🎉b', highlight: true },
    ]);
  });
  it('tolerates empty, unsorted, overlapping and out-of-range input', () => {
    expect(snippetSegments('plain', [])).toEqual([{ text: 'plain', highlight: false }]);
    expect(
      snippetSegments('abcdef', [
        [3, 5],
        [1, 2],
        [4, 9],
      ]),
    ).toEqual([
      { text: 'a', highlight: false },
      { text: 'b', highlight: true },
      { text: 'c', highlight: false },
      { text: 'def', highlight: true },
    ]);
    expect(
      snippetSegments('abc', [
        [5, 9],
        [2, 1],
      ]),
    ).toEqual([{ text: 'abc', highlight: false }]);
    expect(snippetSegments('', [[0, 1]])).toEqual([]);
  });
});

describe('formatTimestamp', () => {
  it('renders m:ss and h:mm:ss', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(65_000)).toBe('1:05');
    expect(formatTimestamp(3_600_000)).toBe('1:00:00');
    expect(formatTimestamp(3_725_500)).toBe('1:02:05');
  });
});
