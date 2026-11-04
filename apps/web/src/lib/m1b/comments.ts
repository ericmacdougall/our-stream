// SPDX-License-Identifier: AGPL-3.0-only
// Comment drafts and thread state. The server de-duplicates a comment by (author, item, clientKey):
// the same key with the same body/parent replays the original (200), a different body answers 409
// idempotency_mismatch. So a draft mints one key when it is created, keeps it through edits, lost
// responses and refusals, persists it with the text across reloads, and only drops it once the
// comment is confirmed posted. A lost response is retried identically up to MAX_ATTEMPTS, then the
// draft is frozen with a manual retry so an edited text can never be sent under the old key.
import type { z } from 'zod';
import type { Comment } from '@our-stream/contracts';

export type CommentThread = z.output<typeof Comment>;
export type CommentNode = CommentThread['replies'][number];

const MAX_ATTEMPTS = 3;
const KEY_MAX = 64;
const BODY_MAX = 2000;

export interface Draft {
  clientKey: string;
  body: string;
  parentId: string | null;
  phase: 'editing' | 'sending' | 'uncertain';
  attempt: number;
  /** Set after a 409 idempotency_mismatch: the earlier attempt had been posted. */
  postedEarlier: boolean;
  mint: () => string;
}

export type DraftEvent =
  | { type: 'edit'; body: string }
  | { type: 'send' }
  | { type: 'sent' }
  | { type: 'failed'; definite: boolean; code?: string }
  | { type: 'retry' };

export interface DraftSend {
  body: string;
  parentId: string | null;
  clientKey: string;
}

export function newDraft(parentId: string | null, mint: () => string): Draft {
  return {
    clientKey: mint(),
    body: '',
    parentId,
    phase: 'editing',
    attempt: 0,
    postedEarlier: false,
    mint,
  };
}

function payload(d: Draft): DraftSend {
  return { body: d.body, parentId: d.parentId, clientKey: d.clientKey };
}

export function reduceDraft(draft: Draft, event: DraftEvent): { draft: Draft; send?: DraftSend } {
  switch (event.type) {
    case 'edit':
      if (draft.phase !== 'editing') return { draft };
      return { draft: { ...draft, body: event.body, postedEarlier: false } };
    case 'send': {
      if (draft.phase !== 'editing' || draft.body.trim() === '') return { draft };
      const next = { ...draft, phase: 'sending' as const, attempt: 1, postedEarlier: false };
      return { draft: next, send: payload(next) };
    }
    case 'retry': {
      if (draft.phase !== 'uncertain') return { draft };
      const next = { ...draft, phase: 'sending' as const, attempt: 1 };
      return { draft: next, send: payload(next) };
    }
    case 'sent':
      if (draft.phase === 'editing') return { draft };
      return { draft: newDraft(draft.parentId, draft.mint) };
    case 'failed': {
      if (draft.phase !== 'sending') return { draft };
      if (!event.definite) {
        if (draft.attempt < MAX_ATTEMPTS) {
          const next = { ...draft, attempt: draft.attempt + 1 };
          return { draft: next, send: payload(next) };
        }
        return { draft: { ...draft, phase: 'uncertain' } };
      }
      if (event.code === 'idempotency_mismatch') {
        // The first attempt was stored with the original text; nothing more to send.
        return { draft: { ...newDraft(draft.parentId, draft.mint), postedEarlier: true } };
      }
      // Any other refusal (comments_disabled, validation, ...): keep text and key for a later try.
      return { draft: { ...draft, phase: 'editing', attempt: 0 } };
    }
  }
}

// ---- persistence (sessionStorage; the key travels with the text) ----
export function draftStorageKey(contentId: string, parentId: string | null): string {
  return `os.comment-draft.${contentId}.${parentId ?? 'root'}`;
}

export function serialiseDraft(draft: Draft): string {
  return JSON.stringify({ clientKey: draft.clientKey, body: draft.body, parentId: draft.parentId });
}

/** A stored draft for the same parent, or a fresh one when the stored value is unusable. */
export function restoreDraft(
  raw: string | null | undefined,
  parentId: string | null,
  mint: () => string,
): Draft {
  const fresh = newDraft(parentId, mint);
  if (!raw) return fresh;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fresh;
  }
  if (!parsed || typeof parsed !== 'object') return fresh;
  const p = parsed as { clientKey?: unknown; body?: unknown; parentId?: unknown };
  if (typeof p.clientKey !== 'string' || p.clientKey === '' || p.clientKey.length > KEY_MAX) {
    return fresh;
  }
  if (typeof p.body !== 'string' || p.body.length > BODY_MAX) return fresh;
  const storedParent = p.parentId === null ? null : p.parentId;
  if (storedParent !== parentId) return fresh;
  return { ...fresh, clientKey: p.clientKey, body: p.body };
}

// ---- thread state ----
function asThread(c: CommentNode | CommentThread): CommentThread {
  if ('replies' in c && Array.isArray(c.replies)) return c;
  return { ...c, replies: [], replyCount: 0 };
}

/** Appends a root, or attaches a reply to its loaded root; idempotent by id. */
export function mergeComment(
  list: readonly CommentThread[],
  created: CommentNode | CommentThread,
): CommentThread[] {
  if (created.parentId !== null) {
    const index = list.findIndex((r) => r.id === created.parentId);
    if (index >= 0) {
      const rootItem = list[index]!;
      if (rootItem.replies.some((x) => x.id === created.id)) return [...list];
      const { replies: _ignored, replyCount: _count, ...reply } = asThread(created);
      void _ignored;
      void _count;
      const updated: CommentThread = {
        ...rootItem,
        replies: [...rootItem.replies, reply],
        replyCount: rootItem.replyCount + 1,
      };
      return list.map((r, i) => (i === index ? updated : r));
    }
    // Root not loaded (older page): keep the reply visible rather than losing it.
  }
  if (list.some((r) => r.id === created.id)) return [...list];
  return [...list, asThread(created)];
}

/** Replaces the removed comment (root or reply) with its tombstone, keeping the thread shape. */
export function applyRemoved(
  list: readonly CommentThread[],
  removed: CommentNode | CommentThread,
): CommentThread[] {
  return list.map((r) => {
    if (r.id === removed.id) {
      const { replies: _r, replyCount: _c, ...core } = asThread(removed);
      void _r;
      void _c;
      return { ...r, ...core, replies: r.replies, replyCount: r.replyCount };
    }
    if (!r.replies.some((x) => x.id === removed.id)) return r;
    const { replies: _r, replyCount: _c, ...core } = asThread(removed);
    void _r;
    void _c;
    return { ...r, replies: r.replies.map((x) => (x.id === removed.id ? { ...x, ...core } : x)) };
  });
}

const UNAVAILABLE = new Set(['content_not_found', 'stale_version', 'not_published', 'not_found']);

/** True when the server says the item is gone for this viewer (retracted, expired, revoked). */
export function isUnavailableCode(code: string | undefined): boolean {
  return code !== undefined && UNAVAILABLE.has(code);
}
