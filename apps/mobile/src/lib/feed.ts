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
