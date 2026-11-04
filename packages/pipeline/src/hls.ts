// SPDX-License-Identifier: AGPL-3.0-only
// HLS fMP4/CMAF transcode: one ffmpeg run writes every rendition plus the master playlist.
// Layout under the derived prefix: hls/master.m3u8, hls/{name}/index.m3u8, hls/{name}/init.mp4,
// hls/{name}/seg_NNN.m4s (video renditions carry muxed AAC; audio uploads get one audio-only rendition).
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execTool } from './exec.js';
import type { MediaInfo } from './ffprobe.js';
import { AUDIO_BITRATE, gopFrames, selectLadder, type Rendition } from './ladder.js';

export interface HlsPlan {
  renditions: Rendition[];
  /** Audio-only rendition (audio uploads, or video without an audio track gets none). */
  audioOnly: Rendition | null;
  args: string[];
}

export interface HlsOptions {
  threads: number;
  /** ffmpeg preset; `veryfast` keeps the worker responsive, `medium` for quality. */
  preset?: string;
}

/** Pure: builds the ffmpeg argument list for the ladder. `outDir` is the derived root. */
export function planHls(info: MediaInfo, input: string, outDir: string, opts: HlsOptions): HlsPlan {
  const preset = opts.preset ?? 'veryfast';
  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-threads',
    String(opts.threads),
    '-i',
    input,
  ];
  const renditions: Rendition[] = [];
  let audioOnly: Rendition | null = null;
  const maps: string[] = [];
  if (info.hasVideo && info.width && info.height) {
    const ladder = selectLadder(info.width, info.height);
    const gop = gopFrames(info.fps);
    const filters = ladder
      .map((r, i) => `[v${i}]scale=${r.width}:${r.height}:flags=lanczos,format=yuv420p[o${i}]`)
      .join(';');
    args.push(
      '-filter_complex',
      `[0:v:0]split=${ladder.length}${ladder.map((_, i) => `[v${i}]`).join('')};${filters}`,
    );
    ladder.forEach((r, i) => {
      args.push('-map', `[o${i}]`);
      if (info.hasAudio) args.push('-map', '0:a:0');
      args.push(
        `-c:v:${i}`,
        'libx264',
        `-preset:v:${i}`,
        preset,
        `-profile:v:${i}`,
        'high',
        `-b:v:${i}`,
        String(r.bitrate),
        `-maxrate:v:${i}`,
        String(Math.round(r.bitrate * 1.07)),
        `-bufsize:v:${i}`,
        String(Math.round(r.bitrate * 1.5)),
      );
      renditions.push(r);
    });
    args.push('-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0');
    if (info.hasAudio)
      args.push('-c:a', 'aac', '-b:a', String(AUDIO_BITRATE), '-ac', '2', '-ar', '48000');
    ladder.forEach((r, i) =>
      maps.push(info.hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`),
    );
  } else if (info.hasAudio) {
    audioOnly = {
      name: 'audio',
      width: 0,
      height: 0,
      bitrate: AUDIO_BITRATE,
      playlist: 'hls/audio/index.m3u8',
    };
    args.push(
      '-map',
      '0:a:0',
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      String(AUDIO_BITRATE),
      '-ac',
      '2',
      '-ar',
      '48000',
    );
    maps.push('a:0,name:audio');
  } else {
    throw new Error('planHls: input has neither video nor audio');
  }
  args.push(
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'independent_segments',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    join(outDir, 'hls', '%v', 'seg_%03d.m4s'),
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    maps.join(' '),
    join(outDir, 'hls', '%v', 'index.m3u8'),
  );
  return { renditions, audioOnly, args };
}

export async function transcodeHls(
  info: MediaInfo,
  input: string,
  outDir: string,
  opts: HlsOptions & { timeoutMs: number },
): Promise<HlsPlan> {
  const plan = planHls(info, input, outDir, opts);
  const names = plan.audioOnly ? [plan.audioOnly.name] : plan.renditions.map((r) => r.name);
  for (const n of names) await mkdir(join(outDir, 'hls', n), { recursive: true });
  await execTool('ffmpeg', plan.args, { timeoutMs: opts.timeoutMs });
  return plan;
}
