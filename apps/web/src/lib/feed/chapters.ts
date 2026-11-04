// SPDX-License-Identifier: AGPL-3.0-only
// Chapter timestamps: authors type mm:ss (or h:mm:ss, or plain seconds); the contract stores ms.
export interface ChapterLike {
  atMs: number;
  title: string;
}

/** Parses "mm:ss", "m:ss", "h:mm:ss", "ss" or "ss.s" into milliseconds; null when invalid. */
export function parseTimestamp(input: string): number | null {
  const text = input.trim();
  if (text === '') return null;
  const parts = text.split(':');
  if (parts.length > 3) return null;
  let totalSeconds = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    const isLast = i === parts.length - 1;
    const re = isLast ? /^\d{1,2}(\.\d{1,3})?$/ : /^\d{1,3}$/;
    if (parts.length === 1 && !/^\d+(\.\d{1,3})?$/.test(part)) return null;
    if (parts.length > 1 && !re.test(part)) return null;
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    if (parts.length > 1 && isLast && value >= 60) return null;
    if (parts.length === 3 && i === 1 && value >= 60) return null;
    totalSeconds = totalSeconds * 60 + value;
  }
  return Math.round(totalSeconds * 1000);
}

/** Formats milliseconds as m:ss or h:mm:ss. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Index of the chapter active at `currentMs`, or -1 before the first chapter. */
export function activeChapterIndex(chapters: readonly ChapterLike[], currentMs: number): number {
  let index = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    const c = chapters[i];
    if (c && c.atMs <= currentMs) index = i;
    else break;
  }
  return index;
}

/** Sorted, de-duplicated chapters ready for the contract. */
export function normaliseChapters(chapters: readonly ChapterLike[]): ChapterLike[] {
  const byTime = new Map<number, ChapterLike>();
  for (const c of chapters) {
    const title = c.title.trim();
    if (title === '' || !Number.isInteger(c.atMs) || c.atMs < 0) continue;
    byTime.set(c.atMs, { atMs: c.atMs, title });
  }
  return [...byTime.values()].sort((a, b) => a.atMs - b.atMs);
}
