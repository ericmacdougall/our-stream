// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { classify, shareUrl, withM1bDefaults } from './api.js';

describe('classify: adapter result mapping', () => {
  it('is ok only for a 2xx with a body', () => {
    const r = classify({ data: { liked: true }, response: { status: 200 } });
    expect(r.ok).toBe(true);
  });
  it('treats an empty-body 2xx as an unknown outcome (lost), never a success', () => {
    const r = classify<{ liked: boolean }>({ data: undefined, response: { status: 200 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lost).toBe(true);
  });
  it('marks no response, empty-body failures and 5xx as lost; a coded 4xx as definite', () => {
    const lost = classify({ error: undefined, response: { status: 502 } });
    expect(lost.ok).toBe(false);
    if (!lost.ok) expect(lost.lost).toBe(true);
    const definite = classify({
      error: { error: { code: 'comments_disabled' } },
      response: { status: 409 },
    });
    expect(definite.ok).toBe(false);
    if (!definite.ok) {
      expect(definite.lost).toBe(false);
      expect(definite.code).toBe('comments_disabled');
    }
  });
});

describe('shareUrl', () => {
  it('prefixes only a single-slash relative path', () => {
    expect(shareUrl('https://x.example/', '/content/abc')).toBe('https://x.example/content/abc');
    for (const bad of ['//evil', '/\\evil', 'https://evil', '/a b', '']) {
      expect(shareUrl('https://x.example', bad), bad).toBeNull();
    }
  });
});

describe('withM1bDefaults', () => {
  it('fills the additive fields and keeps server values', () => {
    expect(withM1bDefaults({ id: 'x' })).toMatchObject({
      tags: [],
      pinned: false,
      likeCount: 0,
      liked: false,
      commentCount: 0,
    });
    expect(
      withM1bDefaults({ id: 'x', likeCount: 3, liked: true, tags: ['training'] }),
    ).toMatchObject({ likeCount: 3, liked: true, tags: ['training'] });
  });
});
