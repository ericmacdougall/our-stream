// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { emptyFeedState, epochsChanged, mergePage, removeItem, shouldLoadMore } from './cursor.js';

const item = (id: string) => ({ id });
const page = (ids: string[], nextCursor: string | null, epochs = { a: 1, c: 1 }) => ({
  items: ids.map(item),
  nextCursor,
  authzEpoch: epochs.a,
  orgContentEpoch: epochs.c,
});

describe('mergePage', () => {
  it('appends pages, advances the cursor and stops when the cursor is null', () => {
    let state = mergePage(emptyFeedState<{ id: string }>(), page(['a', 'b'], 'c1'));
    expect(state.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(state.nextCursor).toBe('c1');
    expect(state.hasMore).toBe(true);
    state = mergePage(state, page(['c'], null));
    expect(state.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(state.hasMore).toBe(false);
  });
  it('drops duplicates that straddle page boundaries', () => {
    const state = mergePage(
      mergePage(emptyFeedState<{ id: string }>(), page(['a', 'b'], 'c1')),
      page(['b', 'c', 'c'], 'c2'),
    );
    expect(state.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
  it('discards loaded items when a page arrives under new epochs (ADR-0004)', () => {
    const first = mergePage(emptyFeedState<{ id: string }>(), page(['a', 'b'], 'c1'));
    const next = mergePage(first, page(['z'], null, { a: 1, c: 2 }));
    expect(next.items.map((i) => i.id)).toEqual(['z']);
    expect(next.epochs).toEqual({ authzEpoch: 1, orgContentEpoch: 2 });
  });
});

describe('epochsChanged', () => {
  it('is false before any epoch is known and true on either counter moving', () => {
    expect(epochsChanged(null, { authzEpoch: 1, orgContentEpoch: 1 })).toBe(false);
    const prev = { authzEpoch: 3, orgContentEpoch: 7 };
    expect(epochsChanged(prev, { authzEpoch: 3, orgContentEpoch: 7 })).toBe(false);
    expect(epochsChanged(prev, { authzEpoch: 4, orgContentEpoch: 7 })).toBe(true);
    expect(epochsChanged(prev, { authzEpoch: 3, orgContentEpoch: 8 })).toBe(true);
  });
});

describe('shouldLoadMore', () => {
  it('loads when empty, near the end, and never after the last page', () => {
    expect(shouldLoadMore(0, { items: [], hasMore: true })).toBe(true);
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map(item);
    expect(shouldLoadMore(0, { items, hasMore: true })).toBe(false);
    expect(shouldLoadMore(3, { items, hasMore: true })).toBe(true);
    expect(shouldLoadMore(5, { items, hasMore: false })).toBe(false);
  });
});

describe('removeItem', () => {
  it('removes a retracted item without touching the cursor', () => {
    const state = mergePage(emptyFeedState<{ id: string }>(), page(['a', 'b'], 'c1'));
    const next = removeItem(state, 'a');
    expect(next.items.map((i) => i.id)).toEqual(['b']);
    expect(next.nextCursor).toBe('c1');
  });
});
