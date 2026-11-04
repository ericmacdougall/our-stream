// SPDX-License-Identifier: AGPL-3.0-only
// Password strength hint. The contract's floor is 12 characters; the hint rewards length first
// (NIST SP 800-63B) and only then character variety. Never blocks beyond the contract minimum.
export const PASSWORD_MIN = 12;

export type PasswordStrength = 'tooShort' | 'weak' | 'fair' | 'strong';

export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN) return 'tooShort';
  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password));
  const distinct = new Set(password).size;
  if (password.length >= 20 && distinct >= 8) return 'strong';
  if (password.length >= 16 && classes >= 2 && distinct >= 6) return 'strong';
  if (classes >= 2 && distinct >= 5) return 'fair';
  return 'weak';
}
