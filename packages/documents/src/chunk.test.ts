// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { chunkBlocks, overlapTail, splitLong } from './chunk.js';
import { DEFAULT_LIMITS, clampLimits } from './limits.js';
import type { Block } from './protocol.js';
import { textSha256, wellFormed } from './text.js';

const para = (text: string, loc: Block['locator'] = {}): Block => ({ text, locator: loc });
const words = (n: number, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

describe('chunkBlocks', () => {
  it('keeps small paragraphs of one unit together, never beyond the target', () => {
    const chunks = chunkBlocks([para('alpha beta'), para('gamma delta'), para('epsilon')]);
    expect(chunks).toEqual([
      { locator: {}, text: 'alpha beta\n\ngamma delta\n\nepsilon', lang: 'en' },
    ]);
  });

  it('never spans a page change and carries no overlap across it', () => {
    const chunks = chunkBlocks([
      para('page one text', { page: 1 }),
      para('page two text', { page: 2 }),
    ]);
    expect(chunks.map((c) => [c.locator, c.text])).toEqual([
      [{ page: 1 }, 'page one text'],
      [{ page: 2 }, 'page two text'],
    ]);
  });

  it('flushes at the target and starts the next chunk with a <=100 character word-aligned overlap', () => {
    const a = words(70); // > 100 chars, < 800
    const b = words(70, 'other');
    const c = words(70, 'third');
    const chunks = chunkBlocks([para(a), para(b), para(c)]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) expect(ch.text.length).toBeLessThanOrEqual(800);
    const tail = overlapTail(chunks[0]!.text, 100);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThanOrEqual(100);
    expect(chunks[1]!.text.startsWith(tail)).toBe(true);
    // The tail starts on a whole word.
    expect(chunks[0]!.text.endsWith(tail)).toBe(true);
    expect(chunks[0]!.text[chunks[0]!.text.length - tail.length - 1]).toMatch(/\s/);
  });

  it('cuts a long paragraph into overlapping windows without losing text', () => {
    const long = words(400); // ~3.2k chars
    const chunks = chunkBlocks([para(long)]);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const ch of chunks) expect(ch.text.length).toBeLessThanOrEqual(800);
    const seen = new Set(chunks.flatMap((c) => c.text.split(' ')));
    for (const w of long.split(' ')) expect(seen.has(w)).toBe(true);
    const wins = splitLong(long, 800, 100);
    for (let i = 1; i < wins.length; i += 1) {
      const prevWords = wins[i - 1]!.split(' ');
      expect(prevWords.includes(wins[i]!.split(' ')[0]!)).toBe(true); // overlap shares at least the first word
    }
  });

  it('starts a new chunk at a heading, prepends the heading and records the heading path', () => {
    const chunks = chunkBlocks([
      { text: 'Intro', locator: {}, heading: true, level: 1 },
      para('first body'),
      { text: 'Details', locator: {}, heading: true, level: 2 },
      para('second body'),
      { text: 'Next', locator: {}, heading: true, level: 1 },
      para('third body'),
    ]);
    expect(chunks).toEqual([
      { locator: { heading: 'Intro' }, text: 'Intro\n\nfirst body', lang: 'en' },
      { locator: { heading: 'Intro > Details' }, text: 'Details\n\nsecond body', lang: 'en' },
      { locator: { heading: 'Next' }, text: 'Next\n\nthird body', lang: 'en' },
    ]);
  });

  it('joins rows into disjoint ranges and keeps long rows whole in windows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      text: `row ${i + 1} ${'x'.repeat(30)}`,
      locator: { sheet: 'S', rowStart: i + 1, rowEnd: i + 1 },
    }));
    const chunks = chunkBlocks(rows);
    expect(chunks.length).toBeGreaterThan(1);
    let next = 1;
    for (const ch of chunks) {
      expect(ch.locator.sheet).toBe('S');
      expect(ch.locator.rowStart).toBe(next);
      next = ch.locator.rowEnd! + 1;
      expect(ch.text.length).toBeLessThanOrEqual(800);
    }
    expect(next).toBe(61);
  });

  it('is deterministic and makes lone surrogates well-formed', () => {
    const blocks = [para('lone \ud800 surrogate and \udc00 another')];
    const a = chunkBlocks(blocks);
    expect(a).toEqual(chunkBlocks(blocks));
    expect(a[0]!.text).toBe('lone � surrogate and � another');
    expect(wellFormed('x\ud83d')).toBe('x�');
    // hash cross-check: NFC of a decomposed and a composed form give one hash
    expect(textSha256('é').equals(textSha256('é'))).toBe(true);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkBlocks([])).toEqual([]);
    expect(chunkBlocks([para('  \n\t ')])).toEqual([]);
  });
});

describe('limits', () => {
  it('clamps requested limits to the hard maxima and accepts stricter ones', () => {
    expect(clampLimits({ maxPdfPages: 10_000, wallMs: 5 }).maxPdfPages).toBe(
      DEFAULT_LIMITS.maxPdfPages,
    );
    expect(clampLimits({ wallMs: 5 }).wallMs).toBe(5);
    expect(clampLimits(undefined)).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS).toMatchObject({
      maxFileBytes: 100 * 1024 * 1024,
      maxOoxmlUncompressedBytes: 500 * 1024 * 1024,
      maxOoxmlRatio: 200,
      maxPdfPages: 500,
      maxTextBytes: 5 * 1024 * 1024,
      maxXlsxCells: 1_000_000,
      maxCsvLineBytes: 1024 * 1024,
      wallMs: 120_000,
    });
  });
});
