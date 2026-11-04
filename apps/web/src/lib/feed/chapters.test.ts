// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  activeChapterIndex,
  formatTimestamp,
  normaliseChapters,
  parseTimestamp,
} from './chapters.js';

describe('parseTimestamp', () => {
  it('parses mm:ss, m:ss, h:mm:ss and bare seconds into milliseconds', () => {
    expect(parseTimestamp('00:00')).toBe(0);
    expect(parseTimestamp('1:05')).toBe(65_000);
    expect(parseTimestamp('12:34')).toBe(754_000);
    expect(parseTimestamp('1:02:03')).toBe(3_723_000);
    expect(parseTimestamp('90')).toBe(90_000);
    expect(parseTimestamp(' 0:07.5 ')).toBe(7_500);
  });
  it('rejects malformed input instead of guessing', () => {
    for (const bad of ['', 'abc', '1:60', '1:2:3:4', '-1:00', '1:', ':30', '00:0a', '1:61:00']) {
      expect(parseTimestamp(bad), bad).toBeNull();
    }
  });
});

describe('formatTimestamp', () => {
  it('round-trips with parseTimestamp', () => {
    for (const ms of [0, 5_000, 65_000, 754_000, 3_723_000]) {
      expect(parseTimestamp(formatTimestamp(ms))).toBe(ms);
    }
    expect(formatTimestamp(3_723_000)).toBe('1:02:03');
    expect(formatTimestamp(-5)).toBe('0:00');
  });
});

describe('activeChapterIndex', () => {
  const chapters = [
    { atMs: 0, title: 'Intro' },
    { atMs: 10_000, title: 'Middle' },
    { atMs: 20_000, title: 'End' },
  ];
  it('returns the last chapter at or before the current time', () => {
    expect(activeChapterIndex(chapters, 0)).toBe(0);
    expect(activeChapterIndex(chapters, 9_999)).toBe(0);
    expect(activeChapterIndex(chapters, 10_000)).toBe(1);
    expect(activeChapterIndex(chapters, 99_000)).toBe(2);
    expect(activeChapterIndex(chapters.slice(1), 500)).toBe(-1);
    expect(activeChapterIndex([], 500)).toBe(-1);
  });
});

describe('normaliseChapters', () => {
  it('sorts, trims, drops empties and de-duplicates by time', () => {
    expect(
      normaliseChapters([
        { atMs: 20_000, title: ' End ' },
        { atMs: 0, title: 'Intro' },
        { atMs: 0, title: 'Intro again' },
        { atMs: 5_000, title: '   ' },
        { atMs: -1, title: 'Negative' },
      ]),
    ).toEqual([
      { atMs: 0, title: 'Intro again' },
      { atMs: 20_000, title: 'End' },
    ]);
  });
});
