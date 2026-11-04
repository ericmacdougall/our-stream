// SPDX-License-Identifier: Apache-2.0
// List bookkeeping for the feed and search results: cursor pages are appended without duplicates,
// reactions are applied optimistically and then replaced by the server's answer.

interface Identified {
  id: string;
}
interface Reactable extends Identified {
  liked: boolean;
  likeCount: number;
}

export function mergeItems<T extends Identified>(existing: T[], page: T[]): T[] {
  const seen = new Set(existing.map((i) => i.id));
  return [...existing, ...page.filter((i) => !seen.has(i.id))];
}

export function optimisticToggle<T extends Reactable>(item: T): T {
  const liked = !item.liked;
  return { ...item, liked, likeCount: Math.max(0, item.likeCount + (liked ? 1 : -1)) };
}

export function withReaction<T extends Reactable>(
  items: T[],
  id: string,
  state: { liked: boolean; likeCount: number },
): T[] {
  return items.map((i) =>
    i.id === id ? { ...i, liked: state.liked, likeCount: state.likeCount } : i,
  );
}

export function removeItem<T extends Identified>(items: T[], id: string): T[] {
  return items.filter((i) => i.id !== id);
}

/**
 * State after a feed page arrives. A replacing load (first page, refresh) resets the active card to
 * the first item: fine for a user-initiated refresh, wrong for a stale-item refresh mid-scroll
 * (the FlatList keeps its offset while the first card would start playing off-screen).
 */
export function applyPage<T extends Identified>(
  prev: T[],
  page: T[],
  replace: boolean,
  activeId: string | null,
): { items: T[]; activeId: string | null } {
  if (!replace) return { items: mergeItems(prev, page), activeId };
  return { items: page, activeId: page[0]?.id ?? null };
}

interface Versioned extends Identified {
  versionId: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  title: string;
  description: string;
}
interface RefreshedDetail {
  id: string;
  title: string;
  description: string;
  currentVersion: {
    id: string;
    durationMs: number | null;
    width: number | null;
    height: number | null;
  } | null;
  media: unknown | null;
  likeCount: number;
  liked: boolean;
  commentCount: number;
}

/**
 * Replaces one feed item in place from its refetched detail (a newer version became current),
 * keeping list order, pagination and the active card. Returns the list without the item when the
 * detail no longer has a playable current version.
 */
export function applyStaleItem<
  T extends Versioned & { media: unknown } & Reactable & { commentCount: number },
>(items: T[], detail: RefreshedDetail): T[] {
  if (!detail.currentVersion || !detail.media) return removeItem(items, detail.id);
  const v = detail.currentVersion;
  return items.map((i) =>
    i.id === detail.id
      ? {
          ...i,
          title: detail.title,
          description: detail.description,
          versionId: v.id,
          durationMs: v.durationMs,
          width: v.width,
          height: v.height,
          media: detail.media,
          likeCount: detail.likeCount,
          liked: detail.liked,
          commentCount: detail.commentCount,
        }
      : i,
  );
}
