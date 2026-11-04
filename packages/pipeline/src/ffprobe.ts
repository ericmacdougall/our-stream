// SPDX-License-Identifier: AGPL-3.0-only
// ffprobe wrapper: JSON streams/format, rotation-aware dimensions, frame rate and durations.
import { execTool } from './exec.js';

export interface MediaInfo {
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Display dimensions after applying any rotation metadata; null for audio-only input. */
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; format_name?: string };
}

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

export function parseFps(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !Number.isFinite(n)) return null;
  const den = d === undefined ? 1 : d;
  if (!den || !Number.isFinite(den)) return null;
  const fps = n / den;
  return fps > 0 && fps < 1000 ? fps : null;
}

/** Pure interpretation of ffprobe JSON so the rules are unit-testable without ffmpeg. */
export function interpretProbe(json: ProbeOutput): MediaInfo {
  const streams = json.streams ?? [];
  const video = streams.find(
    (s) => s.codec_type === 'video' && !(s.disposition?.attached_pic === 1),
  );
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) throw new ProbeError('no audio or video stream');
  const formatDuration = Number(json.format?.duration);
  const streamDuration = Number(video?.duration ?? audio?.duration);
  const seconds =
    Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : streamDuration;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new ProbeError('duration unknown or zero');
  let width: number | null = null;
  let height: number | null = null;
  if (video) {
    if (!video.width || !video.height) throw new ProbeError('video dimensions unknown');
    width = video.width;
    height = video.height;
    const rotRaw = video.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation;
    const rot = Math.abs(rotRaw ?? Number(video.tags?.['rotate'] ?? 0)) % 180;
    if (rot === 90) [width, height] = [height, width];
  }
  return {
    durationMs: Math.round(seconds * 1000),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width,
    height,
    fps: video ? (parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate)) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    container: json.format?.format_name ?? null,
  };
}

export async function probe(path: string, opts: { timeoutMs: number }): Promise<MediaInfo> {
  const { stdout } = await execTool(
    'ffprobe',
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_entries',
      'stream_side_data=rotation',
      path,
    ],
    { timeoutMs: opts.timeoutMs, maxStdoutBytes: 1024 * 1024 },
  );
  let json: ProbeOutput;
  try {
    json = JSON.parse(stdout) as ProbeOutput;
  } catch {
    throw new ProbeError('ffprobe output was not JSON');
  }
  return interpretProbe(json);
}
