// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeAsr, fakeSegments, wavDurationMs } from './fake.js';
import { createWhisperHttpAsr, pickLanguage, toTranscript } from './whisper-http.js';
import { createAsrProviderFromEnv } from './from-env.js';

/** Minimal 16 kHz mono 16-bit PCM WAV with `seconds` of silence. */
function wav(seconds: number): Buffer {
  const byteRate = 16000 * 2;
  const data = Buffer.alloc(byteRate * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asr-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fake asr', () => {
  it('derives deterministic segments from the duration', () => {
    const s = fakeSegments(12_000);
    expect(s).toHaveLength(3);
    expect(s[0]).toEqual({ startMs: 0, endMs: 4000, text: expect.stringContaining('number 1') });
    expect(s[2]?.endMs).toBe(12_000);
    expect(fakeSegments(12_000)).toEqual(s);
    expect(fakeSegments(0)).toEqual([]);
    expect(fakeSegments(4100)).toHaveLength(1); // 100 ms sliver dropped
  });
  it('reads the duration from a WAV header', async () => {
    const p = join(dir, 'three.wav');
    await writeFile(p, wav(3));
    expect(await wavDurationMs(p)).toBe(3000);
    const t = await createFakeAsr().transcribe({ path: p, language: 'de' });
    expect(t.language).toBe('de');
    expect(t.segments).toHaveLength(1);
    const notWav = join(dir, 'not.wav');
    await writeFile(notWav, Buffer.from('nope'));
    expect(await wavDurationMs(notWav)).toBeNull();
    await expect(createFakeAsr().transcribe({ path: notWav })).rejects.toThrow(/duration unknown/);
  });
});

describe('whisper-http mapping', () => {
  it('converts seconds to ms, drops empty segments and picks the language', () => {
    const t = toTranscript(undefined, {
      language: 'german',
      language_probabilities: { en: 0.1, de: 0.85, fr: 0.05 },
      segments: [
        { start: 0, end: 1.5, text: ' Hallo ' },
        { start: 1.5, end: 2, text: '   ' },
        { start: 2.0004, end: 3.9996, text: 'Welt' },
      ],
    });
    expect(t.language).toBe('de');
    expect(t.segments).toEqual([
      { startMs: 0, endMs: 1500, text: 'Hallo' },
      { startMs: 2000, endMs: 4000, text: 'Welt' },
    ]);
    expect(pickLanguage('en', { language_probabilities: { de: 1 } })).toBe('en');
    expect(pickLanguage(undefined, {})).toBe('en');
  });
});

describe('whisper-http adapter against a mock whisper-server', () => {
  let server: Server;
  let url: string;
  let lastRequest: { contentType: string; bodyLength: number; fields: string[] } | null = null;
  let mode: 'ok' | 'error' | 'slow' | 'garbage' = 'ok';
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('latin1');
        const fields = [...text.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
        lastRequest = {
          contentType: req.headers['content-type'] ?? '',
          bodyLength: body.length,
          fields,
        };
        if (req.url !== '/inference' || req.method !== 'POST') {
          res.writeHead(404).end();
          return;
        }
        if (mode === 'error') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'boom' }));
          return;
        }
        if (mode === 'garbage') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('not json');
          return;
        }
        const reply = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              task: 'transcribe',
              language: 'english',
              language_probabilities: { en: 0.9 },
              duration: 3,
              text: 'hello world',
              segments: [{ id: 0, start: 0.0, end: 1.25, text: ' hello world' }],
            }),
          );
        };
        if (mode === 'slow') setTimeout(reply, 500);
        else reply();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    url = `http://127.0.0.1:${addr.port}/`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('posts the WAV as multipart with verbose_json and maps the reply', async () => {
    mode = 'ok';
    const p = join(dir, 'one.wav');
    await writeFile(p, wav(1));
    const asr = createWhisperHttpAsr({ baseUrl: url, timeoutMs: 5000 });
    const t = await asr.transcribe({ path: p, language: 'en' });
    expect(t).toEqual({
      language: 'en',
      segments: [{ startMs: 0, endMs: 1250, text: 'hello world' }],
    });
    expect(lastRequest?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(lastRequest?.fields).toEqual(
      expect.arrayContaining(['file', 'response_format', 'temperature', 'language']),
    );
    expect(lastRequest?.bodyLength).toBeGreaterThan(32_044);
  });
  it('surfaces HTTP errors, non-JSON replies and timeouts as errors without a path', async () => {
    const p = join(dir, 'one.wav');
    const asr = createWhisperHttpAsr({ baseUrl: url, timeoutMs: 100 });
    mode = 'error';
    await expect(asr.transcribe({ path: p })).rejects.toThrow(/HTTP 500/);
    mode = 'garbage';
    await expect(asr.transcribe({ path: p })).rejects.toThrow(/not JSON/);
    mode = 'slow';
    await expect(asr.transcribe({ path: p })).rejects.toThrow(/TimeoutError/);
    mode = 'ok';
    try {
      await createWhisperHttpAsr({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 }).transcribe({
        path: p,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(dir);
    }
  });
});

describe('createAsrProviderFromEnv', () => {
  it('defaults to fake and validates the whisper settings', () => {
    expect(createAsrProviderFromEnv({}).descriptor.id).toBe('asr-fake');
    expect(
      createAsrProviderFromEnv({ ASR_PROVIDER: 'whisper-http', WHISPER_URL: 'http://w:1' })
        .descriptor.id,
    ).toBe('asr-whisper-http');
    expect(() => createAsrProviderFromEnv({ ASR_PROVIDER: 'cloud' })).toThrow(/ASR_PROVIDER/);
    expect(() =>
      createAsrProviderFromEnv({ ASR_PROVIDER: 'whisper-http', WHISPER_TIMEOUT_MS: 'soon' }),
    ).toThrow(/WHISPER_TIMEOUT_MS/);
  });
});
