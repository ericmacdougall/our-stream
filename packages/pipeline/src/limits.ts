// SPDX-License-Identifier: AGPL-3.0-only
// Resource limits for media processing (risk R7): thread cap, per-tool timeouts, input size and the
// temp root. All come from the environment with conservative defaults.

export interface PipelineLimits {
  threads: number;
  probeTimeoutMs: number;
  transcodeTimeoutMs: number;
  thumbsTimeoutMs: number;
  maxInputBytes: number;
  tmpRoot: string | null;
  preset: string;
}

const num = (env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be a number >= ${min}`);
  return Math.floor(n);
};

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): PipelineLimits {
  return {
    threads: num(env, 'FFMPEG_THREADS', 4),
    probeTimeoutMs: num(env, 'FFPROBE_TIMEOUT_MS', 60_000, 1000),
    transcodeTimeoutMs: num(env, 'FFMPEG_TIMEOUT_MS', 30 * 60_000, 1000),
    thumbsTimeoutMs: num(env, 'FFMPEG_THUMBS_TIMEOUT_MS', 5 * 60_000, 1000),
    maxInputBytes: num(env, 'MEDIA_MAX_INPUT_BYTES', 4 * 1024 * 1024 * 1024),
    tmpRoot: env['WORKER_TMP_DIR'] || null,
    preset: env['FFMPEG_PRESET'] || 'veryfast',
  };
}
