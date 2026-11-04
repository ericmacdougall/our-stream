// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  applyPage,
  applyStaleItem,
  mergeItems,
  optimisticToggle,
  removeItem,
  withReaction,
} from './feed';

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

describe('stale item refresh (helper review F8)', () => {
  type Card = Item & {
    versionId: string;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    title: string;
    description: string;
    media: { hls: string } | null;
    commentCount: number;
  };
  const card = (id: string, versionId: string): Card => ({
    id,
    liked: false,
    likeCount: 0,
    versionId,
    durationMs: 8000,
    width: 720,
    height: 1280,
    title: `t-${id}`,
    description: '',
    media: { hls: `/media/${id}/${versionId}/hls/master.m3u8` },
    commentCount: 0,
  });
  const list = [card('a', 'v1'), card('b', 'v1'), card('c', 'v1')];

  it('reproduces the old behaviour: a replacing page load resets the active card to the first item', () => {
    const out = applyPage(list, [card('a', 'v1')], true, 'c');
    expect(out.activeId).toBe('a');
    expect(out.items).toHaveLength(1);
    // Appending keeps the user where they are.
    expect(applyPage(list, [card('d', 'v1')], false, 'c').activeId).toBe('c');
  });

  it('replaces only the stale item, keeping order, siblings and the active card', () => {
    const detail = {
      id: 'b',
      title: 'renamed',
      description: 'd',
      currentVersion: { id: 'v2', durationMs: 9000, width: 1080, height: 1920 },
      media: { hls: '/media/b/v2/hls/master.m3u8' },
      likeCount: 3,
      liked: true,
      commentCount: 2,
    };
    const out = applyStaleItem(list, detail);
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toBe(list[0]);
    expect(out[2]).toBe(list[2]);
    expect(out[1]).toMatchObject({
      versionId: 'v2',
      title: 'renamed',
      durationMs: 9000,
      liked: true,
      likeCount: 3,
      commentCount: 2,
    });
    expect(out[1]?.media).toEqual(detail.media);
  });

  it('drops the item when the refetched detail has no playable version', () => {
    const gone = {
      id: 'b',
      title: 'x',
      description: '',
      currentVersion: null,
      media: null,
      likeCount: 0,
      liked: false,
      commentCount: 0,
    };
    expect(applyStaleItem(list, gone).map((i) => i.id)).toEqual(['a', 'c']);
  });
});
