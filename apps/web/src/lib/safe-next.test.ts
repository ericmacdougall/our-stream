// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next.js';

describe('safeNext', () => {
  it('keeps same-origin paths', () => {
    expect(safeNext('/upload')).toBe('/upload');
    expect(safeNext('/content/abc/publish?x=1')).toBe('/content/abc/publish?x=1');
    expect(safeNext(['/streams', '/other'])).toBe('/streams');
  });
  it('refuses open-redirect shapes', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '/foo\\bar',
      'upload',
      '',
      undefined,
      '/ok\nhttp://evil',
    ]) {
      expect(safeNext(bad), String(bad)).toBe('/');
    }
  });
});
