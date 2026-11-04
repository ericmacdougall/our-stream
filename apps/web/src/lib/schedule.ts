// SPDX-License-Identifier: AGPL-3.0-only
// datetime-local values have no zone: they are the viewer's wall-clock time. Convert through a Date
// built from local components so DST and offset are the browser's, then send ISO-8601 UTC.
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function localDateTimeToIso(value: string): string | null {
  const m = LOCAL_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
  );
  if (Number.isNaN(date.getTime())) return null;
  // Reject impossible dates that Date silently rolled over (e.g. 2026-02-31).
  if (date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null;
  return date.toISOString();
}

/** Formats an ISO instant as a datetime-local value in the viewer's zone (minute precision). */
export function isoToLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
