// SPDX-License-Identifier: AGPL-3.0-only
// Vertical-aware HLS ladder (ADR-0003). Pure: the source dimensions decide orientation and the tiers
// that do not upscale; each tier is fitted inside its box keeping the aspect ratio with even dimensions.

export interface Rendition {
  /** Stable name used in playlist paths, e.g. `720p`. */
  name: string;
  width: number;
  height: number;
  /** Video bitrate in bit/s. */
  bitrate: number;
  playlist: string;
}

interface Tier {
  name: string;
  /** Long edge in pixels. */
  long: number;
  /** Short edge in pixels. */
  short: number;
  bitrate: number;
}

// ADR-0003 numbers: 9:16 1080x1920 ~5.5 Mbit/s, 720x1280 ~2.8, 540x960 ~1.4, 360x640 ~0.6; the 16:9
// ladder uses the same boxes rotated.
const TIERS: Tier[] = [
  { name: '1080p', long: 1920, short: 1080, bitrate: 5_500_000 },
  { name: '720p', long: 1280, short: 720, bitrate: 2_800_000 },
  { name: '540p', long: 960, short: 540, bitrate: 1_400_000 },
  { name: '360p', long: 640, short: 360, bitrate: 600_000 },
];

export const AUDIO_BITRATE = 128_000;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Scales (w, h) to fit inside (boxW, boxH) without upscaling, rounding to even pixels. */
export function fitWithin(
  w: number,
  h: number,
  boxW: number,
  boxH: number,
): { width: number; height: number } {
  const scale = Math.min(1, boxW / w, boxH / h);
  return { width: even(w * scale), height: even(h * scale) };
}

export function isPortrait(width: number, height: number): boolean {
  return height > width;
}

/**
 * Tiers whose box is not larger than the source on its long edge. A source smaller than the smallest
 * tier gets one rendition at its own (even) size with the smallest tier's bitrate.
 */
export function selectLadder(width: number, height: number): Rendition[] {
  if (!(width > 0 && height > 0)) throw new Error('selectLadder: dimensions required');
  const portrait = isPortrait(width, height);
  const long = Math.max(width, height);
  const out: Rendition[] = [];
  for (const t of TIERS) {
    if (t.long > long) continue;
    const box = portrait ? { w: t.short, h: t.long } : { w: t.long, h: t.short };
    const fit = fitWithin(width, height, box.w, box.h);
    out.push({
      name: t.name,
      width: fit.width,
      height: fit.height,
      bitrate: t.bitrate,
      playlist: `hls/${t.name}/index.m3u8`,
    });
  }
  if (out.length === 0) {
    const smallest = TIERS[TIERS.length - 1]!;
    out.push({
      name: 'source',
      width: even(width),
      height: even(height),
      bitrate: smallest.bitrate,
      playlist: 'hls/source/index.m3u8',
    });
  }
  return out;
}

/** GOP of 2 s at the source frame rate (ADR-0003: 2 s GOP, 4 s segments, independent segments). */
export function gopFrames(fps: number | null): number {
  const f = fps && fps > 0 ? fps : 30;
  return Math.max(1, Math.round(2 * f));
}
