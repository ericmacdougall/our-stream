// SPDX-License-Identifier: AGPL-3.0-only
// Media pipeline orchestrator (ADR-0003 probe → transcode → thumbnails → asr → captions → upload).
// Works on local files in a per-run temp directory that is always removed; storage and ASR are injected.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { AsrProvider, Transcript } from '@our-stream/providers';
import { segmentsToVtt } from './captions.js';
import { execTool, ToolError } from './exec.js';
import { probe, ProbeError, type MediaInfo } from './ffprobe.js';
import { transcodeHls } from './hls.js';
import type { Rendition } from './ladder.js';
import type { PipelineLimits } from './limits.js';
import { InputTooLargeError, type ObjectStore } from './s3.js';
import { renderPoster, renderSprite, spritePlan, spriteVtt } from './thumbs.js';

export type PipelineStep =
  'download' | 'probe' | 'transcode' | 'thumbnails' | 'asr' | 'captions' | 'upload';

export const PIPELINE_STEPS: readonly PipelineStep[] = [
  'download',
  'probe',
  'transcode',
  'thumbnails',
  'asr',
  'captions',
  'upload',
];

/** Keys are relative to `orgs/{org}/content/{content}/versions/{version}/derived/`. */
export interface MediaAssets {
  hls: { master: string; renditions: Rendition[] };
  poster?: string;
  sprite?: string;
  spriteVtt?: string;
  captions: Record<string, string>;
}

/** Stored transcript shape (migration 0002 comment: snake_case segment fields). */
export interface StoredTranscript {
  language: string;
  provider: string;
  segments: { start_ms: number; end_ms: number; text: string }[];
}

export interface PipelineResult {
  assets: MediaAssets;
  transcript: StoredTranscript | null;
  meta: {
    duration_ms: number;
    width: number | null;
    height: number | null;
    has_audio: boolean;
    has_video: boolean;
    video_codec: string | null;
    audio_codec: string | null;
  };
  derivedKeys: string[];
  info: MediaInfo;
}

export interface PipelineInput {
  originalKey: string;
  /** Storage prefix for derived files, without a trailing slash. */
  derivedPrefix: string;
  /** Content language hint for ASR; undefined means detect. */
  language?: string;
}

export interface PipelineDeps {
  store: ObjectStore;
  asr: AsrProvider;
  limits: PipelineLimits;
  onStep?: (step: PipelineStep) => Promise<void>;
}

/** Failure with a message safe to persist (no paths, no stderr); the original error is the cause. */
export class PipelineError extends Error {
  constructor(
    public readonly step: PipelineStep,
    public readonly publicMessage: string,
    cause: unknown,
  ) {
    super(`${step}: ${publicMessage}`, { cause });
    this.name = 'PipelineError';
  }
}

const PATH_RE = /(?:[A-Za-z]:)?(?:\/|\\)[^\s'"`]+/g;

/** Strips anything that looks like a filesystem path or URL from a free-form error message. */
export function redactMessage(message: string): string {
  return message.replace(PATH_RE, '<path>').slice(0, 300);
}

export function describeFailure(err: unknown): string {
  if (err instanceof ToolError)
    return `${err.tool} ${err.kind === 'exit' ? `exited with status ${err.exitCode ?? 'signal'}` : err.kind}`;
  if (err instanceof ProbeError) return `unreadable media: ${err.message}`;
  if (err instanceof InputTooLargeError) return err.message;
  if (err instanceof Error) return redactMessage(`${err.name}: ${err.message}`);
  return 'unknown error';
}

async function step<T>(name: PipelineStep, deps: PipelineDeps, fn: () => Promise<T>): Promise<T> {
  await deps.onStep?.(name);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(name, describeFailure(err), err);
  }
}

export async function runMediaPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const { limits } = deps;
  const root = limits.tmpRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(join(root, 'ourstream-media-'));
  try {
    const original = join(work, 'original');
    const derived = join(work, 'derived');
    await mkdir(derived);

    await step('download', deps, () =>
      deps.store.download(input.originalKey, original, limits.maxInputBytes),
    );
    const info = await step('probe', deps, () =>
      probe(original, { timeoutMs: limits.probeTimeoutMs }),
    );

    const hls = await step('transcode', deps, () =>
      transcodeHls(info, original, derived, {
        threads: limits.threads,
        preset: limits.preset,
        timeoutMs: limits.transcodeTimeoutMs,
      }),
    );
    const renditions = hls.audioOnly ? [hls.audioOnly] : hls.renditions;
    const assets: MediaAssets = { hls: { master: 'hls/master.m3u8', renditions }, captions: {} };

    if (info.hasVideo && info.width && info.height) {
      const w = info.width;
      const h = info.height;
      await step('thumbnails', deps, async () => {
        await renderPoster(original, info, join(derived, 'poster.jpg'), {
          timeoutMs: limits.thumbsTimeoutMs,
          threads: limits.threads,
        });
        const plan = spritePlan(info.durationMs, w, h);
        await renderSprite(original, plan, join(derived, 'sprite.jpg'), {
          timeoutMs: limits.thumbsTimeoutMs,
          threads: limits.threads,
        });
        await writeFile(join(derived, 'sprite.vtt'), spriteVtt(plan, info.durationMs), 'utf8');
        assets.poster = 'poster.jpg';
        assets.sprite = 'sprite.jpg';
        assets.spriteVtt = 'sprite.vtt';
      });
    }

    let transcript: Transcript | null = null;
    if (info.hasAudio) {
      transcript = await step('asr', deps, async () => {
        const wav = join(work, 'audio.wav');
        await execTool(
          'ffmpeg',
          [
            '-hide_banner',
            '-nostdin',
            '-y',
            '-threads',
            String(limits.threads),
            '-i',
            original,
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'pcm_s16le',
            wav,
          ],
          { timeoutMs: limits.transcodeTimeoutMs },
        );
        return deps.asr.transcribe({
          path: wav,
          durationMs: info.durationMs,
          ...(input.language ? { language: input.language } : {}),
        });
      });
      await step('captions', deps, async () => {
        if (!transcript || transcript.segments.length === 0) return;
        const lang = transcript.language;
        await mkdir(join(derived, 'captions'), { recursive: true });
        await writeFile(
          join(derived, 'captions', `${lang}.vtt`),
          segmentsToVtt(transcript.segments, lang),
          'utf8',
        );
        assets.captions[lang] = `captions/${lang}.vtt`;
      });
    }

    const derivedKeys = await step('upload', deps, async () => {
      const uploaded = await deps.store.uploadDir(input.derivedPrefix, derived);
      // Idempotent re-run: remove keys from an earlier run that this run did not produce.
      const existing = await deps.store.list(posix.join(input.derivedPrefix, '/'));
      const stale = existing.filter((k) => !uploaded.includes(k));
      if (stale.length > 0) await deps.store.deleteKeys(stale);
      return uploaded;
    });

    return {
      assets,
      transcript: transcript
        ? {
            language: transcript.language,
            provider: deps.asr.descriptor.id,
            segments: transcript.segments.map((s) => ({
              start_ms: s.startMs,
              end_ms: s.endMs,
              text: s.text,
            })),
          }
        : null,
      meta: {
        duration_ms: info.durationMs,
        width: info.width,
        height: info.height,
        has_audio: info.hasAudio,
        has_video: info.hasVideo,
        video_codec: info.videoCodec,
        audio_codec: info.audioCodec,
      },
      derivedKeys,
      info,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
