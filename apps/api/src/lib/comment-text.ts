// SPDX-License-Identifier: AGPL-3.0-only
// Comment bodies: one normal form (NFC, risk R11) with control, bidi-override and zero-width characters
// removed (plan review F14), then the synchronous small-rule-set scanner of ADR-0009 §5. The API stores
// and returns plain text; it never renders HTML, so markup is kept verbatim for clients to escape.

// C0 (except \t and \n), DEL and C1 controls; zero-width space, word joiner, BOM; bidi embeddings,
// overrides and isolates. ZWJ/ZWNJ (U+200C/U+200D) stay: emoji sequences and Persian/Indic scripts need them.
const STRIP =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;

export const COMMENT_MAX_UNITS = 2000;

export function normalizeCommentBody(raw: string): string {
  return raw.normalize('NFC').replace(STRIP, '').trim();
}

export type ScanCategory = 'secret' | 'pii';
export interface ScanFinding {
  category: ScanCategory;
  detector: string;
}

// Secrets: cloud keys, private keys, tokens. PII: email addresses, card-like digit runs. Findings carry the
// detector name only, never the matched value (ADR-0009 §2).
const DETECTORS: Array<{ category: ScanCategory; detector: string; re: RegExp }> = [
  { category: 'secret', detector: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { category: 'secret', detector: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { category: 'secret', detector: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  {
    category: 'secret',
    detector: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  { category: 'secret', detector: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { category: 'pii', detector: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { category: 'pii', detector: 'card_number', re: /\b(?:\d[ -]?){13,19}\b/ },
];

export function scanComment(body: string): ScanFinding[] {
  const found: ScanFinding[] = [];
  for (const d of DETECTORS) {
    if (!d.re.test(body)) continue;
    if (d.detector === 'card_number' && !luhnInText(body)) continue;
    found.push({ category: d.category, detector: d.detector });
  }
  return found;
}

function luhnInText(body: string): boolean {
  for (const m of body.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let n = Number(digits[i]);
      if (dbl) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      dbl = !dbl;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export type ScanPolicy = 'off' | 'warn' | 'block';

/** The policy decision: `block` refuses when any secret or PII is found; `warn` only reports. */
export function scanVerdict(
  policy: ScanPolicy,
  findings: ScanFinding[],
): { blocked: boolean; categories: ScanCategory[] } {
  const categories = [...new Set(findings.map((f) => f.category))];
  return { blocked: policy === 'block' && categories.length > 0, categories };
}
