// SPDX-License-Identifier: AGPL-3.0-only
// Feed cursor: (publish_at, id) keyset, base64url so clients treat it as opaque.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(publishAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([publishAt.toISOString(), id])).toString('base64url');
}

export function decodeCursor(cursor: string): { publishAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [iso, id] = parsed as [unknown, unknown];
    if (typeof iso !== 'string' || typeof id !== 'string' || !UUID_RE.test(id)) return null;
    const publishAt = new Date(iso);
    if (Number.isNaN(publishAt.getTime())) return null;
    return { publishAt, id };
  } catch {
    return null;
  }
}
