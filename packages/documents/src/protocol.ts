// SPDX-License-Identifier: AGPL-3.0-only
// Wire contract between the worker and the parser sandbox, exchanged as files in the single job slot:
//   /slot/input.bin   the original (copied by the worker)
//   /slot/job.json    JobFile, written last and atomically (the parser starts when it appears)
//   /slot/result.json ResultFile, written by the parser, treated by the worker as untrusted
// and the control directory (/ctl): heartbeat.json, challenge-<id>.json, response-<id>.json.
import { z } from 'zod';
import { MAX_RESULT_FILE_BYTES, type ParseLimits } from './limits.js';

export const DOC_KINDS = ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'md'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** Extension -> kind; legacy .doc/.ppt/.xls and macro-enabled variants are deliberately absent. */
export const EXTENSION_KIND: Readonly<Record<string, DocKind>> = Object.freeze({
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
  csv: 'csv',
  md: 'md',
  markdown: 'md',
});

export const KIND_MIMES: Readonly<Record<DocKind, readonly string[]>> = Object.freeze({
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv', 'application/csv', 'text/plain'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
});

export const REFUSAL_CODES = [
  'file_too_large',
  'ooxml_too_large',
  'ooxml_ratio',
  'pdf_pages',
  'text_too_large',
  'cell_limit',
  'csv_line',
  'wall_time',
  'memory',
  'spoofed_type',
  'password_protected',
  'macro_enabled',
  'unsafe_path',
  'xml_dtd',
  'nul_bytes',
  'no_text',
  'malformed',
  'unsupported',
  'block_limit',
  'internal',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Locator {
  page?: number | undefined;
  slide?: number | undefined;
  sheet?: string | undefined;
  rowStart?: number | undefined;
  rowEnd?: number | undefined;
  heading?: string | undefined;
}

export interface Block {
  text: string;
  locator: Locator;
  /** A heading starts a new chunk and sets the heading path for the blocks after it. */
  heading?: boolean | undefined;
  /** Heading level (1 = top); used to maintain the heading path. */
  level?: number | undefined;
}

const LocatorSchema = z.strictObject({
  page: z.number().int().positive().max(1_000_000).optional(),
  slide: z.number().int().positive().max(1_000_000).optional(),
  sheet: z.string().max(200).optional(),
  rowStart: z.number().int().positive().max(100_000_000).optional(),
  rowEnd: z.number().int().positive().max(100_000_000).optional(),
  heading: z.string().max(400).optional(),
});

export const BlockSchema = z.strictObject({
  text: z.string().max(MAX_RESULT_FILE_BYTES),
  locator: LocatorSchema,
  heading: z.boolean().optional(),
  level: z.number().int().min(1).max(9).optional(),
});

const LimitsSchema = z.strictObject({
  maxFileBytes: z.number().positive().optional(),
  maxOoxmlUncompressedBytes: z.number().positive().optional(),
  maxOoxmlRatio: z.number().positive().optional(),
  maxPdfPages: z.number().positive().optional(),
  maxTextBytes: z.number().positive().optional(),
  maxXlsxCells: z.number().positive().optional(),
  maxCsvLineBytes: z.number().positive().optional(),
  wallMs: z.number().positive().optional(),
  heapMb: z.number().positive().optional(),
  maxBlocks: z.number().positive().optional(),
});

export const JobFileSchema = z.strictObject({
  v: z.literal(1),
  jobId: z.string().regex(/^[0-9a-f]{32}$/),
  /** What the worker expects the file to be (from the stored extension and MIME); the parser sniffs. */
  kind: z.enum(DOC_KINDS),
  declaredMime: z.string().max(200).nullable(),
  declaredExt: z.string().max(16).nullable(),
  limits: LimitsSchema.optional(),
});
export type JobFile = z.infer<typeof JobFileSchema>;

export const ResultFileSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    v: z.literal(1),
    jobId: z.string().regex(/^[0-9a-f]{32}$/),
    ok: z.literal(true),
    kind: z.enum(DOC_KINDS),
    pages: z.number().int().min(0).max(10_000_000).optional(),
    blocks: z.array(BlockSchema).max(1_000_000),
  }),
  z.strictObject({
    v: z.literal(1),
    jobId: z.string().regex(/^[0-9a-f]{32}$/),
    ok: z.literal(false),
    code: z.enum(REFUSAL_CODES),
  }),
]);
export type ResultFile = z.infer<typeof ResultFileSchema>;

export const HeartbeatSchema = z.strictObject({
  v: z.literal(1),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  startedAt: z.string().max(40),
  ts: z.string().max(40),
  selfTest: z.strictObject({
    ok: z.boolean(),
    network: z.enum(['blocked', 'open']),
    rootfs: z.enum(['readonly', 'writable']),
    nonRoot: z.boolean(),
    noSecretEnv: z.boolean(),
  }),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const ChallengeSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[0-9a-f]{32}$/),
});
export const ChallengeResponseSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[0-9a-f]{32}$/),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  selfTestOk: z.boolean(),
});

export type { ParseLimits };
