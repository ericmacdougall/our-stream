// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';

/** Makes lone UTF-16 surrogates well-formed (U+FFFD) so the text survives jsonb and UTF-8 encoding. */
export function wellFormed(text: string): string {
  // String.prototype.toWellFormed is ES2024; the runtime (Node >= 24) has it, the shared tsconfig lib does not.
  return (text as string & { toWellFormed(): string }).toWellFormed();
}

/** Same definition as the SQL trigger: SHA-256 of the UTF-8 bytes of the NFC-normalised text. Tests only. */
export function textSha256(text: string): Buffer {
  return createHash('sha256').update(text.normalize('NFC'), 'utf8').digest();
}

export function hasNul(text: string): boolean {
  return text.includes('\u0000');
}

/** One paragraph's text: CRLF to LF, tabs and runs of spaces collapsed, lines trimmed, blank lines dropped. */
export function normalizeParagraph(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\p{Zs}\t\v\f]+/gu, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
