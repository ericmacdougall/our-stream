// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { t } from './i18n.js';

describe('i18n', () => {
  it('formats ICU placeholders', () => {
    expect(t('status.apiReachable', { version: '1.2.3' })).toBe('API version 1.2.3 is reachable.');
  });
});
