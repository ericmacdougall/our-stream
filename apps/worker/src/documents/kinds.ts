// SPDX-License-Identifier: AGPL-3.0-only
import { KIND_MIMES, type DocKind } from '@our-stream/documents';

/**
 * The worker sees only the stored MIME type (platform_version_brief does not return the file name), so the
 * API must store the canonical allow-listed type per extension. `text/plain` and `application/csv` are
 * ambiguous or non-canonical and are refused rather than guessed.
 */
const CANONICAL: Record<string, DocKind> = {};
for (const [kind, mimes] of Object.entries(KIND_MIMES) as [DocKind, readonly string[]][])
  for (const m of mimes) if (m !== 'text/plain' && m !== 'application/csv') CANONICAL[m] = kind;

export function kindFromMime(mime: string | null): DocKind | null {
  if (!mime) return null;
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  return CANONICAL[base] ?? null;
}
