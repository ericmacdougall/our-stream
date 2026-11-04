// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { mergeItems, optimisticToggle, removeItem, withReaction } from './feed';

type Item = { id: string; liked: boolean; likeCount: number };
const a: Item = { id: 'a', liked: false, likeCount: 2 };
const b: Item = { id: 'b', liked: true, likeCount: 1 };

describe('mergeItems', () => {
  it('appends new items and drops duplicates, keeping order', () => {
    expect(
      mergeItems(
        [a, b],
        [
          { ...b, likeCount: 9 },
          { id: 'c', liked: false, likeCount: 0 },
        ],
      ).map((i) => i.id),
    ).toEqual(['a', 'b', 'c']);
    expect(mergeItems([], [a])).toEqual([a]);
  });
});

describe('reactions', () => {
  it('toggles optimistically without going below zero', () => {
    expect(optimisticToggle(a)).toEqual({ id: 'a', liked: true, likeCount: 3 });
    expect(optimisticToggle(b)).toEqual({ id: 'b', liked: false, likeCount: 0 });
    expect(optimisticToggle({ id: 'z', liked: true, likeCount: 0 })).toEqual({
      id: 'z',
      liked: false,
      likeCount: 0,
    });
  });
  it('applies the server state to the matching item only', () => {
    const out = withReaction([a, b], 'b', { liked: false, likeCount: 7 });
    expect(out[0]).toBe(a);
    expect(out[1]).toEqual({ id: 'b', liked: false, likeCount: 7 });
  });
  it('removes an item that is no longer available', () => {
    expect(removeItem([a, b], 'a')).toEqual([b]);
    expect(removeItem([a, b], 'zz')).toEqual([a, b]);
  });
});
