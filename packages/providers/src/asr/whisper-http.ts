// SPDX-License-Identifier: AGPL-3.0-only
// whisper.cpp `whisper-server` adapter (self-hosted sidecar, compose profile `whisper`).
// API: POST {baseUrl}/inference multipart/form-data with `file` (16 kHz mono WAV, which the pipeline
// produces so the server needs no `--convert`), `response_format=verbose_json`; segments come back with
// `start`/`end` in seconds. Verified against examples/server/server.cpp on 2026-11-03.
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import type { AsrProvider, ProviderDescriptor, Transcript, TranscribeInput } from '../types.js';

export const whisperHttpDescriptor: ProviderDescriptor = {
  id: 'asr-whisper-http',
  vendor: 'ggml-org/whisper.cpp',
  capability: 'asr',
  models: [{ id: 'ggml (configured on the server)' }],
  regions: ['local'],
  retentionClass: 'self_hosted',
  trainingUse: 'never',
  requiresContract: false,
  residencyNotes: 'Runs inside the deployment; audio never leaves the cluster network.',
  sourceUrl: 'https://github.com/ggml-org/whisper.cpp/tree/master/examples/server',
  verifiedOn: '2026-11-03',
};

export interface WhisperHttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface VerboseJson {
  language?: string;
  language_probabilities?: Record<string, number>;
  segments?: { start?: number; end?: number; text?: string }[];
  text?: string;
  error?: string;
}

/** Maps whisper's response to a BCP-47 subtag: requested language wins, then the most probable code. */
export function pickLanguage(requested: string | undefined, body: VerboseJson): string {
  if (requested) return requested;
  const probs = body.language_probabilities;
  if (probs) {
    let best: string | null = null;
    let bestP = -1;
    for (const [code, p] of Object.entries(probs)) {
      if (typeof p === 'number' && p > bestP) {
        best = code;
        bestP = p;
      }
    }
    if (best) return best;
  }
  return 'en';
}

export function toTranscript(requested: string | undefined, body: VerboseJson): Transcript {
  const segments: Transcript['segments'] = [];
  for (const s of body.segments ?? []) {
    if (typeof s.start !== 'number' || typeof s.end !== 'number') continue;
    const text = (s.text ?? '').trim();
    if (!text) continue;
    const startMs = Math.max(0, Math.round(s.start * 1000));
    const endMs = Math.max(startMs, Math.round(s.end * 1000));
    segments.push({ startMs, endMs, text });
  }
  return { language: pickLanguage(requested, body), segments };
}

export function createWhisperHttpAsr(opts: WhisperHttpOptions): AsrProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    descriptor: whisperHttpDescriptor,
    async transcribe(input: TranscribeInput): Promise<Transcript> {
      const form = new FormData();
      form.set('file', await openAsBlob(input.path, { type: 'audio/wav' }), basename(input.path));
      form.set('response_format', 'verbose_json');
      form.set('temperature', '0.0');
      if (input.language) form.set('language', input.language);
      let res: Response;
      try {
        res = await fetchImpl(`${base}/inference`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`whisper-http: request failed (${(err as Error).name})`, { cause: err });
      }
      if (!res.ok) throw new Error(`whisper-http: server returned HTTP ${res.status}`);
      let body: VerboseJson;
      try {
        body = (await res.json()) as VerboseJson;
      } catch (err) {
        throw new Error('whisper-http: response was not JSON', { cause: err });
      }
      if (body.error) throw new Error(`whisper-http: server error: ${String(body.error)}`);
      return toTranscript(input.language, body);
    },
  };
}
