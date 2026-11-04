// SPDX-License-Identifier: Apache-2.0
// Search snippets: the API gives highlight ranges as UTF-16 code-unit offsets (ADR-0013), which is
// exactly what JavaScript string indices are, so slicing is direct. Ranges are still normalised and
// snapped to code-point boundaries so a malformed range can never split a surrogate pair.

export interface Segment {
  text: string;
  highlight: boolean;
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Moves an index off the middle of a surrogate pair: starts move left, ends move right. */
function snap(text: string, index: number, end: boolean): number {
  if (index <= 0 || index >= text.length) return index;
  if (isLow(text.charCodeAt(index)) && isHigh(text.charCodeAt(index - 1)))
    return end ? index + 1 : index - 1;
  return index;
}

export function snippetSegments(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): Segment[] {
  if (!text) return [];
  const clean = ranges
    .map(
      ([s, e]) =>
        [
          snap(text, Math.max(0, Math.min(s, text.length)), false),
          snap(text, Math.max(0, Math.min(e, text.length)), true),
        ] as [number, number],
    )
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of clean) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: Segment[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) out.push({ text: text.slice(cursor, s), highlight: false });
    out.push({ text: text.slice(s, e), highlight: true });
    cursor = e;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), highlight: false });
  return out;
}

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}
