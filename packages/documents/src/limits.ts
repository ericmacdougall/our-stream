// SPDX-License-Identifier: AGPL-3.0-only
// Parse limits (spec M2a NEG-1). Defaults are owner-chosen, configurable through the job file the worker
// writes; the parser clamps every value to these hard maxima so a forged job file cannot raise a budget.

export const MIB = 1024 * 1024;

export interface ParseLimits {
  /** Original file size, enforced again in the parser (presign checks the declared size, complete the actual). */
  maxFileBytes: number;
  /** Sum of uncompressed entry sizes of an OOXML package. */
  maxOoxmlUncompressedBytes: number;
  /** Uncompressed / compressed ratio of an OOXML package (and of any large entry). */
  maxOoxmlRatio: number;
  maxPdfPages: number;
  /** Extracted text, all blocks together. */
  maxTextBytes: number;
  maxXlsxCells: number;
  maxCsvLineBytes: number;
  /** Parser wall clock per job. */
  wallMs: number;
  /** V8 old-generation heap of the extraction thread; the container cgroup (1 GiB) is the outer wall. */
  heapMb: number;
  maxBlocks: number;
}

export const DEFAULT_LIMITS: Readonly<ParseLimits> = Object.freeze({
  maxFileBytes: 100 * MIB,
  maxOoxmlUncompressedBytes: 500 * MIB,
  maxOoxmlRatio: 200,
  maxPdfPages: 500,
  maxTextBytes: 5 * MIB,
  maxXlsxCells: 1_000_000,
  maxCsvLineBytes: 1 * MIB,
  wallMs: 120_000,
  heapMb: 768,
  maxBlocks: 1_000_000,
});

/** Never lower-bounded here: a smaller value only makes the job stricter. */
export function clampLimits(
  requested: { [K in keyof ParseLimits]?: number | undefined } | undefined,
): ParseLimits {
  const out = { ...DEFAULT_LIMITS } as ParseLimits;
  if (!requested) return out;
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ParseLimits)[]) {
    const v = requested[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0)
      out[key] = Math.min(v, DEFAULT_LIMITS[key]);
  }
  return out;
}

/** Result file size ceiling the worker accepts: 5 MiB of text escapes to well under 32 MiB of JSON. */
export const MAX_RESULT_FILE_BYTES = 32 * MIB;

export const CHUNK_TARGET_CHARS = 800;
export const CHUNK_OVERLAP_CHARS = 100;
/** `platform_document_finish` fails a version over these (chunk_limit). */
export const DB_MAX_CHUNK_CHARS = 8000;
export const DB_MAX_CHUNKS = 20000;
