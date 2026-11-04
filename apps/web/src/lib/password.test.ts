// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { passwordStrength } from './password.js';

describe('passwordStrength', () => {
  it('follows the contract floor and rewards length over variety', () => {
    expect(passwordStrength('short')).toBe('tooShort');
    expect(passwordStrength('aaaaaaaaaaaa')).toBe('weak');
    expect(passwordStrength('correct horse')).toBe('fair');
    expect(passwordStrength('correct horse battery')).toBe('strong');
    expect(passwordStrength('Tr0ub4dor&3xtra!')).toBe('strong');
  });
});
