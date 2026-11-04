// SPDX-License-Identifier: AGPL-3.0-only
// Media fixtures for the mock API. With ffmpeg on PATH a 6 s 9:16 H.264/AAC HLS ladder (fMP4) is
// generated into test/.fixtures (git-ignored); otherwise the committed tiny.mp4/tiny.webm serve as
// progressive fallbacks. MOCK_MEDIA=hls|mp4|webm forces a mode; the default is auto.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = join(here, '..', 'fixtures');
export const generatedDir = join(here, '..', '.fixtures');

export const CAPTIONS_VTT = `WEBVTT

00:00.000 --> 00:02.000
Welcome to the team.

00:02.000 --> 00:04.000
This clip was generated for testing.

00:04.000 --> 00:06.000
Captions toggle with the C key.
`;

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return r.status === 0;
}

function generateHls() {
  const dir = join(generatedDir, 'hls');
  if (existsSync(join(dir, 'master.m3u8'))) return true;
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=360x640:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '6',
        '-c:v',
        'libx264',
        '-profile:v',
        'main',
        '-preset',
        'veryfast',
        '-g',
        '60',
        '-keyint_min',
        '60',
        '-sc_threshold',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-hls_time',
        '2',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_type',
        'fmp4',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_filename',
        join(dir, 'seg_%03d.m4s'),
        '-master_pl_name',
        'master.m3u8',
        join(dir, 'index.m3u8'),
      ],
      { stdio: 'inherit' },
    );
    return existsSync(join(dir, 'master.m3u8'));
  } catch {
    return false;
  }
}

/**
 * @returns {{ mode: 'hls'|'mp4'|'webm', dir: string, playlist: string|null, file: string|null, durationMs: number, contentType: Record<string,string> }}
 */
export function prepareFixtures() {
  const requested = process.env['MOCK_MEDIA'] ?? 'auto';
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, 'en.vtt'), CAPTIONS_VTT);
  const common = {
    contentType: {
      '.m3u8': 'application/vnd.apple.mpegurl',
      '.m4s': 'video/iso.segment',
      '.mp4': 'video/mp4',
      '.ts': 'video/mp2t',
      '.webm': 'video/webm',
      '.vtt': 'text/vtt; charset=utf-8',
      '.jpg': 'image/jpeg',
    },
  };
  if ((requested === 'auto' || requested === 'hls') && hasFfmpeg() && generateHls()) {
    return {
      mode: 'hls',
      dir: join(generatedDir, 'hls'),
      playlist: 'master.m3u8',
      file: null,
      durationMs: 6000,
      ...common,
    };
  }
  if (requested === 'hls') throw new Error('MOCK_MEDIA=hls requested but ffmpeg is unavailable');
  if (requested === 'webm') {
    return {
      mode: 'webm',
      dir: fixturesDir,
      playlist: null,
      file: 'tiny.webm',
      durationMs: 6000,
      ...common,
    };
  }
  return {
    mode: 'mp4',
    dir: fixturesDir,
    playlist: null,
    file: 'tiny.mp4',
    durationMs: 1000,
    ...common,
  };
}
