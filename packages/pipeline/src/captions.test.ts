// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  MAX_CUE_MS,
  MAX_LINES,
  MAX_LINE_CHARS,
  formatVttTime,
  segmentsToCues,
  segmentsToVtt,
  splitSegment,
  wrapWords,
} from './captions.js';
import { posterTimeMs, spritePlan, spriteVtt } from './thumbs.js';
import { describeFailure, redactMessage } from './process.js';
import { ToolError } from './exec.js';

describe('captions', () => {
  it('formats timestamps as HH:MM:SS.mmm', () => {
    expect(formatVttTime(0)).toBe('00:00:00.000');
    expect(formatVttTime(3_723_456)).toBe('01:02:03.456');
    expect(formatVttTime(-5)).toBe('00:00:00.000');
  });
  it('wraps at 42 characters on word boundaries', () => {
    const lines = wrapWords(
      'the quick brown fox jumps over the lazy dog again and again until dawn'.split(' '),
    );
    expect(lines.every((l) => l.length <= MAX_LINE_CHARS)).toBe(true);
    expect(lines.join(' ')).toBe(
      'the quick brown fox jumps over the lazy dog again and again until dawn',
    );
    expect(wrapWords(['x'.repeat(60)])).toEqual(['x'.repeat(60)]);
  });
  it('keeps a short segment as one cue', () => {
    expect(splitSegment({ startMs: 0, endMs: 4000, text: 'hello world' })).toEqual([
      { startMs: 0, endMs: 4000, lines: ['hello world'] },
    ]);
    expect(splitSegment({ startMs: 0, endMs: 4000, text: '   ' })).toEqual([]);
  });
  it('splits a long segment into cues of <= 7 s and <= 2 lines, covering the whole span', () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const cues = splitSegment({ startMs: 1000, endMs: 31_000, text });
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) {
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(MAX_CUE_MS);
      expect(c.lines.length).toBeLessThanOrEqual(MAX_LINES);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
    }
    expect(cues[0]?.startMs).toBe(1000);
    expect(cues[cues.length - 1]?.endMs).toBe(31_000);
    for (let i = 1; i < cues.length; i += 1) expect(cues[i]!.startMs).toBe(cues[i - 1]!.endMs);
    expect(
      cues
        .flatMap((c) => c.lines)
        .join(' ')
        .split(' ').length,
    ).toBeGreaterThanOrEqual(60);
  });
  it('time-splits a short text spoken slowly without inventing words', () => {
    const cues = splitSegment({ startMs: 0, endMs: 20_000, text: 'yes' });
    expect(cues).toHaveLength(3);
    expect(cues.every((c) => c.lines[0] === 'yes' && c.endMs - c.startMs <= MAX_CUE_MS)).toBe(true);
  });
  it('removes overlaps, drops empty segments and escapes markup in the VTT', () => {
    const vtt = segmentsToVtt(
      [
        { startMs: 2000, endMs: 5000, text: 'second <b>bold</b>' },
        { startMs: 0, endMs: 3000, text: 'first --> arrow' },
        { startMs: 6000, endMs: 6000, text: 'zero length' },
      ],
      'en',
    );
    expect(vtt.startsWith('WEBVTT\nLanguage: en\n\n1\n00:00:00.000 --> 00:00:03.000\n')).toBe(true);
    expect(vtt).toContain('first → arrow');
    expect(vtt).toContain('00:00:03.000 --> 00:00:05.000\nsecond &lt;b&gt;bold&lt;/b&gt;');
    expect(vtt).not.toContain('zero length');
    expect(segmentsToCues([])).toEqual([]);
  });
});

describe('thumbnails', () => {
  it('poster at 1 s, or 10 % for short clips', () => {
    expect(posterTimeMs(60_000)).toBe(1000);
    expect(posterTimeMs(10_000)).toBe(1000);
    expect(posterTimeMs(4000)).toBe(400);
  });
  it('plans a 10x10 sheet of 108 px tiles every 2 s for a 12 s portrait clip', () => {
    const plan = spritePlan(12_000, 720, 1280);
    expect(plan).toEqual({
      intervalMs: 2000,
      tileWidth: 108,
      tileHeight: 192,
      cols: 10,
      rows: 10,
      count: 6,
    });
    expect(spritePlan(12_000, 1280, 720).tileHeight).toBe(60); // 60.75 rounded to even
  });
  it('widens the interval so long clips still fit one sheet', () => {
    const plan = spritePlan(1_000_000, 1920, 1080);
    expect(plan.intervalMs).toBe(10_000);
    expect(plan.count).toBe(100);
  });
  it('writes xywh cues that walk the grid row by row and end at the duration', () => {
    const plan = spritePlan(23_000, 720, 1280);
    const vtt = spriteVtt(plan, 23_000);
    const cues = vtt.trimEnd().split('\n\n').slice(1).filter(Boolean);
    expect(cues).toHaveLength(12);
    expect(cues[0]).toBe('00:00:00.000 --> 00:00:02.000\nsprite.jpg#xywh=0,0,108,192');
    expect(cues[9]).toBe('00:00:18.000 --> 00:00:20.000\nsprite.jpg#xywh=972,0,108,192');
    expect(cues[10]).toBe('00:00:20.000 --> 00:00:22.000\nsprite.jpg#xywh=0,192,108,192');
    expect(cues[11]).toBe('00:00:22.000 --> 00:00:23.000\nsprite.jpg#xywh=108,192,108,192');
  });
});

describe('failure redaction', () => {
  it('never includes paths or stderr in the persisted message', () => {
    const tool = new ToolError(
      'ffmpeg',
      'exit',
      1,
      '/tmp/ourstream-media-x/original: Invalid data',
    );
    expect(describeFailure(tool)).toBe('ffmpeg exited with status 1');
    expect(describeFailure(new ToolError('ffprobe', 'timeout', null, ''))).toBe('ffprobe timeout');
    expect(describeFailure(new Error('ENOENT: open /var/tmp/abc/audio.wav'))).toBe(
      'Error: ENOENT: open <path>',
    );
    expect(redactMessage('C:\\Users\\x\\file.wav failed')).toBe('<path> failed');
    expect(describeFailure('x')).toBe('unknown error');
  });
});
