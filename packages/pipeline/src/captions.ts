// SPDX-License-Identifier: AGPL-3.0-only
// WebVTT captions from ASR segments: cues of at most 7 s and 2 lines of ~42 characters; longer segments
// are split at word boundaries with time distributed by character share.
import type { TranscriptSegment } from '@our-stream/providers';

export const MAX_CUE_MS = 7000;
export const MAX_LINES = 2;
export const MAX_LINE_CHARS = 42;

export interface Cue {
  startMs: number;
  endMs: number;
  lines: string[];
}

export function formatVttTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const f = total % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(f, 3)}`;
}

/** Greedy word wrap into lines of at most `max` characters (a single long word gets its own line). */
export function wrapWords(words: string[], max = MAX_LINE_CHARS): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur === '') cur = w;
    else if (cur.length + 1 + w.length <= max) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

/** Splits one segment into cues that respect the duration and line limits. */
export function splitSegment(seg: TranscriptSegment): Cue[] {
  const words = seg.text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = wrapWords(words);
  // Group lines into chunks of MAX_LINES, then further split chunks that would exceed MAX_CUE_MS.
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += MAX_LINES) chunks.push(lines.slice(i, i + MAX_LINES));
  const totalChars = words.join(' ').length;
  const duration = Math.max(0, seg.endMs - seg.startMs);
  const out: Cue[] = [];
  let cursor = seg.startMs;
  let charsSoFar = 0;
  chunks.forEach((chunk, idx) => {
    const chunkChars = chunk.join(' ').length;
    charsSoFar += chunkChars;
    const end =
      idx === chunks.length - 1
        ? seg.endMs
        : seg.startMs + Math.round((duration * charsSoFar) / totalChars);
    out.push({ startMs: cursor, endMs: Math.max(cursor, end), lines: chunk });
    cursor = end;
  });
  // Time split: any cue longer than MAX_CUE_MS is divided into equal parts, each repeating the text
  // (keeps the reading window short without inventing word timings the ASR did not provide).
  const bounded: Cue[] = [];
  for (const cue of out) {
    const len = cue.endMs - cue.startMs;
    if (len <= MAX_CUE_MS) {
      bounded.push(cue);
      continue;
    }
    const parts = Math.ceil(len / MAX_CUE_MS);
    for (let p = 0; p < parts; p += 1) {
      const s = cue.startMs + Math.round((len * p) / parts);
      const e = p === parts - 1 ? cue.endMs : cue.startMs + Math.round((len * (p + 1)) / parts);
      bounded.push({ startMs: s, endMs: e, lines: cue.lines });
    }
  }
  return bounded;
}

export function segmentsToCues(segments: TranscriptSegment[]): Cue[] {
  const cues: Cue[] = [];
  for (const seg of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    if (seg.endMs <= seg.startMs) continue;
    cues.push(...splitSegment(seg));
  }
  // Cues must not overlap for a predictable render; clamp each start to the previous end.
  for (let i = 1; i < cues.length; i += 1) {
    const prev = cues[i - 1]!;
    const cur = cues[i]!;
    if (cur.startMs < prev.endMs) cur.startMs = prev.endMs;
    if (cur.endMs < cur.startMs) cur.endMs = cur.startMs;
  }
  return cues.filter((c) => c.endMs > c.startMs);
}

// The cue-timing arrow is replaced before `>` is escaped so it can never be read as a timing line.
const escapeVtt = (s: string) =>
  s.replace(/-->/g, '→').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function segmentsToVtt(segments: TranscriptSegment[], language?: string): string {
  const lines = ['WEBVTT'];
  if (language) lines.push(`Language: ${language}`);
  lines.push('');
  let n = 0;
  for (const cue of segmentsToCues(segments)) {
    n += 1;
    lines.push(String(n), `${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}`);
    lines.push(...cue.lines.map(escapeVtt), '');
  }
  return lines.join('\n');
}
