// SPDX-License-Identifier: AGPL-3.0-only
// Email identity (risk R11): NFKC normalisation plus case folding so visually identical addresses map
// to one account. The display form keeps what the user typed (trimmed).

export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFKC').toLowerCase();
}

/** Default display name for an invited account: the local part, never the full address. */
export function displayNameFromEmail(email: string): string {
  const local = email.trim().split('@')[0] ?? 'member';
  return local.length > 0 ? local.slice(0, 120) : 'member';
}
