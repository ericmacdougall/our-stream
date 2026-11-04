// SPDX-License-Identifier: AGPL-3.0-only
// Cursor pagination state for the feed: pages are appended without duplicates, the cursor advances,
// and an epoch change from /sync or a later page invalidates everything loaded so far (ADR-0004).
export interface Epochs {
  authzEpoch: number;
  orgContentEpoch: number;
}

export interface PageLike<T> {
  items: T[];
  nextCursor: string | null;
  authzEpoch: number;
  orgContentEpoch: number;
}

export interface FeedPagesState<T> {
  items: T[];
  nextCursor: string | null;
  /** False once the server returned a null cursor. */
  hasMore: boolean;
  epochs: Epochs | null;
}

export function emptyFeedState<T>(): FeedPagesState<T> {
  return { items: [], nextCursor: null, hasMore: true, epochs: null };
}

export function epochsChanged(prev: Epochs | null, next: Epochs): boolean {
  if (!prev) return false;
  return prev.authzEpoch !== next.authzEpoch || prev.orgContentEpoch !== next.orgContentEpoch;
}

/**
 * Appends a page. If the page's epochs differ from what we already hold, the stale items are
 * dropped and the page becomes the new first page (callers also refetch from the start).
 */
export function mergePage<T extends { id: string }>(
  state: FeedPagesState<T>,
  page: PageLike<T>,
): FeedPagesState<T> {
  const pageEpochs = { authzEpoch: page.authzEpoch, orgContentEpoch: page.orgContentEpoch };
  const base = epochsChanged(state.epochs, pageEpochs) ? emptyFeedState<T>() : state;
  const seen = new Set(base.items.map((i) => i.id));
  const fresh = page.items.filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
  return {
    items: [...base.items, ...fresh],
    nextCursor: page.nextCursor,
    hasMore: page.nextCursor !== null,
    epochs: pageEpochs,
  };
}

/** Load the next page when the viewer is within `threshold` items of the end. */
export function shouldLoadMore(
  activeIndex: number,
  state: Pick<FeedPagesState<unknown>, 'items' | 'hasMore'>,
  threshold = 3,
): boolean {
  if (!state.hasMore) return false;
  return state.items.length === 0 || activeIndex >= state.items.length - threshold;
}

export function removeItem<T extends { id: string }>(
  state: FeedPagesState<T>,
  id: string,
): FeedPagesState<T> {
  return { ...state, items: state.items.filter((i) => i.id !== id) };
}
