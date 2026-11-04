// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic ASR fake: one segment per ~4 s of audio with stable text, so pipeline tests can assert
// captions without a model. Duration comes from the caller or from the WAV header of the input file.
import { open } from 'node:fs/promises';
import type { AsrProvider, ProviderDescriptor, Transcript, TranscribeInput } from '../types.js';

export const fakeAsrDescriptor: ProviderDescriptor = {
  id: 'asr-fake',
  vendor: 'our-stream',
  capability: 'asr',
  models: [{ id: 'fake' }],
  regions: ['local'],
  retentionClass: 'self_hosted',
  trainingUse: 'never',
  requiresContract: false,
  residencyNotes: 'In-process; no data leaves the worker.',
  sourceUrl: 'https://github.com/ericmacdougall/our-stream',
  verifiedOn: '2026-11-03',
};

const SEGMENT_MS = 4000;
const WORDS = ['this', 'is', 'a', 'placeholder', 'transcript', 'segment', 'number'];

/** Reads the duration of a PCM WAV file from its header (RIFF/fmt/data chunks); null when not a WAV. */
export async function wavDurationMs(path: string): Promise<number | null> {
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    if (bytesRead < 12 || head.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let offset = 12;
    let byteRate = 0;
    const chunk = Buffer.alloc(8);
    for (let i = 0; i < 64; i += 1) {
      const r = await fh.read(chunk, 0, 8, offset);
      if (r.bytesRead < 8) return null;
      const id = chunk.toString('ascii', 0, 4);
      const size = chunk.readUInt32LE(4);
      if (id === 'fmt ') {
        const fmt = Buffer.alloc(16);
        const fr = await fh.read(fmt, 0, 16, offset + 8);
        if (fr.bytesRead < 16) return null;
        byteRate = fmt.readUInt32LE(8);
      } else if (id === 'data') {
        if (byteRate === 0) return null;
        return Math.round((size / byteRate) * 1000);
      }
      offset += 8 + size + (size % 2);
    }
    return null;
  } finally {
    await fh.close();
  }
}

export function fakeSegments(durationMs: number): Transcript['segments'] {
  const segments: Transcript['segments'] = [];
  for (let start = 0, i = 0; start < durationMs; start += SEGMENT_MS, i += 1) {
    const end = Math.min(start + SEGMENT_MS, durationMs);
    if (end - start < 250) break; // trailing sliver: not worth a cue
    const words = WORDS.map((w) => (w === 'number' ? `${w} ${i + 1}` : w));
    segments.push({ startMs: start, endMs: end, text: words.join(' ') + '.' });
  }
  return segments;
}

export function createFakeAsr(): AsrProvider {
  return {
    descriptor: fakeAsrDescriptor,
    async transcribe(input: TranscribeInput): Promise<Transcript> {
      const durationMs = input.durationMs ?? (await wavDurationMs(input.path));
      if (durationMs === null)
        throw new Error('fake asr: duration unknown (not a WAV file and no durationMs given)');
      return { language: input.language ?? 'en', segments: fakeSegments(durationMs) };
    },
  };
}
