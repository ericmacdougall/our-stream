// SPDX-License-Identifier: AGPL-3.0-only
// Poster frame and sprite sheet with a WebVTT thumbnails track (ADR-0003).
import { execTool } from './exec.js';
import type { MediaInfo } from './ffprobe.js';
import { formatVttTime } from './captions.js';

export const SPRITE_COLS = 10;
export const SPRITE_ROWS = 10;
export const SPRITE_TILE_WIDTH = 108;

export interface SpritePlan {
  intervalMs: number;
  tileWidth: number;
  tileHeight: number;
  cols: number;
  rows: number;
  /** Tiles actually populated (<= cols*rows). */
  count: number;
}

/** Poster at 1 s, or at 10 % of the duration for clips shorter than 10 s. */
export function posterTimeMs(durationMs: number): number {
  return durationMs >= 10_000 ? 1000 : Math.floor(durationMs / 10);
}

/**
 * One frame every 2 s on a 10x10 sheet of 108 px wide tiles. Longer clips widen the interval so a
 * single sheet always suffices (count <= 100). Tile height follows the source aspect, even-rounded.
 */
export function spritePlan(durationMs: number, width: number, height: number): SpritePlan {
  const maxTiles = SPRITE_COLS * SPRITE_ROWS;
  const seconds = durationMs / 1000;
  const intervalS = Math.max(2, Math.ceil(seconds / maxTiles));
  const count = Math.min(maxTiles, Math.max(1, Math.ceil(seconds / intervalS)));
  const tileHeight = Math.max(2, Math.round((SPRITE_TILE_WIDTH * height) / width / 2) * 2);
  return {
    intervalMs: intervalS * 1000,
    tileWidth: SPRITE_TILE_WIDTH,
    tileHeight,
    cols: SPRITE_COLS,
    rows: SPRITE_ROWS,
    count,
  };
}

/** WebVTT thumbnails track: each cue points at a tile with `#xywh=x,y,w,h` relative to `spriteFile`. */
export function spriteVtt(plan: SpritePlan, durationMs: number, spriteFile = 'sprite.jpg'): string {
  const lines = ['WEBVTT', ''];
  for (let i = 0; i < plan.count; i += 1) {
    const start = i * plan.intervalMs;
    const end = Math.min(durationMs, start + plan.intervalMs);
    if (end <= start) break;
    const x = (i % plan.cols) * plan.tileWidth;
    const y = Math.floor(i / plan.cols) * plan.tileHeight;
    lines.push(
      `${formatVttTime(start)} --> ${formatVttTime(end)}`,
      `${spriteFile}#xywh=${x},${y},${plan.tileWidth},${plan.tileHeight}`,
      '',
    );
  }
  return lines.join('\n');
}

export async function renderPoster(
  input: string,
  info: MediaInfo,
  out: string,
  opts: { timeoutMs: number; threads: number },
): Promise<void> {
  const at = posterTimeMs(info.durationMs) / 1000;
  await execTool(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-threads',
      String(opts.threads),
      '-ss',
      at.toFixed(3),
      '-i',
      input,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      '-vf',
      'scale=min(1280\\,iw):-2',
      out,
    ],
    { timeoutMs: opts.timeoutMs },
  );
}

export async function renderSprite(
  input: string,
  plan: SpritePlan,
  out: string,
  opts: { timeoutMs: number; threads: number },
): Promise<void> {
  const fps = 1000 / plan.intervalMs;
  await execTool(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-threads',
      String(opts.threads),
      '-i',
      input,
      '-vf',
      `fps=${fps},scale=${plan.tileWidth}:${plan.tileHeight},tile=${plan.cols}x${plan.rows}`,
      '-frames:v',
      '1',
      '-q:v',
      '5',
      out,
    ],
    { timeoutMs: opts.timeoutMs },
  );
}
