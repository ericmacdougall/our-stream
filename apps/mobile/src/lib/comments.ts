// SPDX-License-Identifier: Apache-2.0
// Comment drafts and thread updates over the contract types (Comment with replies).
import type { Comment } from '@our-stream/contracts';
import type { z } from 'zod';

export type CommentThread = z.output<typeof Comment>;
export type CommentNode = CommentThread['replies'][number];

export const COMMENT_MAX_UNITS = 2000;

/** Trimmed body when it fits the contract (1..2000 UTF-16 units), otherwise null. */
export function validateCommentBody(raw: string): string | null {
  const body = raw.trim();
  if (body.length < 1 || body.length > COMMENT_MAX_UNITS) return null;
  return body;
}

export interface CommentDraft {
  /** Idempotency key fixed when the draft is created so a retry replays rather than duplicates. */
  clientKey: string;
  parentId: string | null;
  body: string;
}

export function newDraft(newKey: () => string, parentId: string | null): CommentDraft {
  return { clientKey: newKey(), parentId, body: '' };
}

/**
 * Edits keep the key only while the payload is unchanged: the same key with a different body or
 * parent would answer 409 `idempotency_mismatch`, while an unchanged retry must replay.
 */
export function editDraft(
  draft: CommentDraft,
  change: Partial<Pick<CommentDraft, 'body' | 'parentId'>>,
  newKey: () => string,
): CommentDraft {
  const body = change.body ?? draft.body;
  const parentId = change.parentId === undefined ? draft.parentId : change.parentId;
  if (body === draft.body && parentId === draft.parentId) return draft;
  return { clientKey: newKey(), parentId, body };
}

/** Replies attach to a root; replying to a reply targets that reply's root (contract CreateCommentRequest). */
export function replyTarget(threads: CommentThread[], commentId: string): string | null {
  for (const t of threads) {
    if (t.id === commentId) return t.id;
    if (t.replies.some((r) => r.id === commentId)) return t.id;
  }
  return null;
}

/** Adds a freshly posted comment: a root goes first, a reply joins its root's replies. */
export function insertReply(
  threads: CommentThread[],
  posted: CommentNode | CommentThread,
): CommentThread[] {
  if (posted.parentId === null) {
    const asThread: CommentThread = {
      ...posted,
      replies: 'replies' in posted ? posted.replies : [],
      replyCount: 'replyCount' in posted ? posted.replyCount : 0,
    };
    return [asThread, ...threads.filter((t) => t.id !== posted.id)];
  }
  return threads.map((t) => {
    if (t.id !== posted.parentId) return t;
    if (t.replies.some((r) => r.id === posted.id)) return t;
    const node: CommentNode = stripThread(posted);
    return { ...t, replies: [...t.replies, node], replyCount: t.replyCount + 1 };
  });
}

function stripThread(c: CommentNode | CommentThread): CommentNode {
  const { id, contentId, parentId, author, body, state, createdAt, removedAt, canRemove } = c;
  const node: CommentNode = {
    id,
    contentId,
    parentId,
    author,
    body,
    state,
    createdAt,
    removedAt,
    canRemove,
  };
  if (c.reportCount !== undefined) node.reportCount = c.reportCount;
  return node;
}

export function mergeThreads(
  existing: CommentThread[],
  incoming: CommentThread[],
): CommentThread[] {
  const seen = new Set(existing.map((t) => t.id));
  return [...existing, ...incoming.filter((t) => !seen.has(t.id))];
}

/** Replaces the removed comment (root or reply) with the tombstone the API returned. */
export function applyRemoved(
  threads: CommentThread[],
  removed: CommentNode | CommentThread,
): CommentThread[] {
  return threads.map((t) => {
    if (t.id === removed.id) return { ...t, ...stripThread(removed) };
    if (!t.replies.some((r) => r.id === removed.id)) return t;
    return {
      ...t,
      replies: t.replies.map((r) => (r.id === removed.id ? stripThread(removed) : r)),
    };
  });
}
