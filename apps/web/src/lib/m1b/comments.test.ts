// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  applyRemoved,
  clearDrafts,
  draftStorageKey,
  isUnavailableCode,
  mergeComment,
  newDraft,
  reduceDraft,
  restoreDraft,
  serialiseDraft,
  type CommentNode,
  type Draft,
} from './comments.js';

const author = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Ann' };
function node(id: string, parentId: string | null, body = 'hi'): CommentNode {
  return {
    id,
    contentId: 'c1',
    parentId,
    author,
    body,
    state: 'visible',
    createdAt: '2026-11-04T00:00:00.000Z',
    removedAt: null,
    canRemove: true,
  };
}
const root = { ...node('r1', null), replies: [], replyCount: 0 };

function sending(mint = () => 'k'): Draft {
  const edited = reduceDraft(newDraft(null, mint), { type: 'edit', body: 'hello' }).draft;
  return reduceDraft(edited, { type: 'send' }).draft;
}

describe('drafts keep one clientKey per text until it is settled', () => {
  it('mints a key once; a lost response is retried identically up to 3 times, then frozen with Retry', () => {
    let keys = 0;
    const mint = () => `k${++keys}`;
    const d = sending(mint);
    expect(d).toMatchObject({ phase: 'sending', clientKey: 'k1', attempt: 1 });
    const r1 = reduceDraft(d, { type: 'failed', definite: false });
    expect(r1.draft).toMatchObject({ phase: 'sending', clientKey: 'k1', attempt: 2 });
    expect(r1.send).toEqual({ body: 'hello', parentId: null, clientKey: 'k1' });
    const r2 = reduceDraft(r1.draft, { type: 'failed', definite: false });
    expect(r2.draft.attempt).toBe(3);
    expect(r2.send?.clientKey).toBe('k1');
    const r3 = reduceDraft(r2.draft, { type: 'failed', definite: false });
    expect(r3.draft).toMatchObject({ phase: 'uncertain', clientKey: 'k1', body: 'hello' });
    expect(r3.send).toBeUndefined();
    // Manual retry resends the identical payload; edits are ignored while uncertain.
    expect(reduceDraft(r3.draft, { type: 'edit', body: 'changed' }).draft).toBe(r3.draft);
    const retry = reduceDraft(r3.draft, { type: 'retry' });
    expect(retry.send).toEqual({ body: 'hello', parentId: null, clientKey: 'k1' });
    expect(retry.draft).toMatchObject({ phase: 'sending', attempt: 1 });
    expect(keys).toBe(1);
  });
  it('ignores edits and a second send while sending (edit-while-pending, double submit)', () => {
    const d = sending();
    expect(reduceDraft(d, { type: 'edit', body: 'changed' }).draft).toBe(d);
    expect(reduceDraft(d, { type: 'send' }).draft).toBe(d);
    expect(reduceDraft(d, { type: 'send' }).send).toBeUndefined();
  });
  it('a definite refusal returns to editing with the text kept and the SAME key (replay-safe)', () => {
    const back = reduceDraft(sending(), { type: 'failed', definite: true }).draft;
    expect(back).toMatchObject({ phase: 'editing', body: 'hello', clientKey: 'k' });
  });
  it('409 idempotency_mismatch means the earlier attempt was posted: clear, new key, say so', () => {
    let keys = 0;
    const mint = () => `k${++keys}`;
    const out = reduceDraft(sending(mint), {
      type: 'failed',
      definite: true,
      code: 'idempotency_mismatch',
    }).draft;
    expect(out).toMatchObject({ phase: 'editing', body: '', clientKey: 'k2', postedEarlier: true });
  });
  it('comments_disabled while sending keeps the draft text for later', () => {
    const out = reduceDraft(sending(), {
      type: 'failed',
      definite: true,
      code: 'comments_disabled',
    }).draft;
    expect(out).toMatchObject({ phase: 'editing', body: 'hello', clientKey: 'k' });
  });
  it('after a successful send the next draft gets a fresh key', () => {
    let keys = 0;
    const mint = () => `k${++keys}`;
    const done = reduceDraft(sending(mint), { type: 'sent' }).draft;
    expect(done).toMatchObject({ phase: 'editing', body: '', clientKey: 'k2', attempt: 0 });
  });
  it('does not send an empty or whitespace-only body', () => {
    const d = reduceDraft(
      newDraft(null, () => 'k'),
      { type: 'edit', body: '   ' },
    ).draft;
    const out = reduceDraft(d, { type: 'send' });
    expect(out.draft.phase).toBe('editing');
    expect(out.send).toBeUndefined();
  });
  it('persists and restores an unsent draft with its key (reload cannot mint a second key)', () => {
    const d = reduceDraft(
      newDraft('r1', () => 'k9'),
      { type: 'edit', body: 'kept' },
    ).draft;
    expect(draftStorageKey('u1', 'c1', 'r1')).toBe('os.comment-draft.u1.c1.r1');
    expect(draftStorageKey('u1', 'c1', null)).toBe('os.comment-draft.u1.c1.root');
    // Another user never shares a key with the same clip (shared-browser sign-out safety).
    expect(draftStorageKey('u2', 'c1', 'r1')).not.toBe(draftStorageKey('u1', 'c1', 'r1'));
    const restored = restoreDraft(serialiseDraft(d), 'r1', () => 'fresh');
    expect(restored).toMatchObject({
      clientKey: 'k9',
      body: 'kept',
      parentId: 'r1',
      phase: 'editing',
    });
    // A draft that had been sent at least once comes back frozen with its key: the text may already
    // be stored under it, so only an identical Retry or a Discard is possible, never an edit.
    const inflight = restoreDraft(serialiseDraft(sending(() => 'k1')), null, () => 'fresh');
    expect(inflight).toMatchObject({ phase: 'uncertain', clientKey: 'k1', body: 'hello' });
    expect(reduceDraft(inflight, { type: 'edit', body: 'changed' }).draft).toBe(inflight);
    // Garbage, a foreign shape, a different parent or an oversized key yields a fresh draft.
    expect(restoreDraft('{"nope":1}', null, () => 'fresh').clientKey).toBe('fresh');
    expect(restoreDraft('not json', null, () => 'fresh').clientKey).toBe('fresh');
    expect(restoreDraft(null, null, () => 'fresh').clientKey).toBe('fresh');
    expect(restoreDraft(serialiseDraft(d), 'other', () => 'fresh').clientKey).toBe('fresh');
    const big = { ...d, clientKey: 'x'.repeat(65) };
    expect(restoreDraft(serialiseDraft(big), 'r1', () => 'fresh').clientKey).toBe('fresh');
  });
});

describe('thread merging', () => {
  it('appends a new root and attaches a reply to its root', () => {
    const withRoot = mergeComment([], root);
    expect(withRoot).toHaveLength(1);
    const reply = node('x1', 'r1');
    const withReply = mergeComment(withRoot, reply);
    expect(withReply[0]?.replies).toEqual([reply]);
    expect(withReply[0]?.replyCount).toBe(1);
  });
  it('is idempotent: a replayed comment (same id) is not duplicated', () => {
    const once = mergeComment(mergeComment([], root), node('x1', 'r1'));
    const twice = mergeComment(once, node('x1', 'r1'));
    expect(twice[0]?.replies).toHaveLength(1);
    expect(twice[0]?.replyCount).toBe(1);
    expect(mergeComment(twice, root)).toHaveLength(1);
  });
  it('a reply whose root is not loaded is kept as a root placeholder (never dropped silently)', () => {
    const orphan = mergeComment([], node('x2', 'missing'));
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.id).toBe('x2');
  });
  it('replaces a removed comment with its tombstone, keeping the thread shape', () => {
    const list = mergeComment(mergeComment([], root), node('x1', 'r1'));
    const tomb = {
      ...node('x1', 'r1'),
      author: null,
      body: null,
      state: 'removed' as const,
      removedAt: '2026-11-04T01:00:00.000Z',
      canRemove: false,
    };
    const after = applyRemoved(list, tomb);
    expect(after[0]?.replies[0]).toMatchObject({ id: 'x1', state: 'removed', body: null });
    const rootTomb = { ...root, author: null, body: null, state: 'removed' as const };
    expect(applyRemoved(list, rootTomb)[0]).toMatchObject({
      state: 'removed',
      replies: list[0]?.replies,
    });
  });
});

describe('clearDrafts', () => {
  it('removes only draft keys from a storage', () => {
    const store = new Map<string, string>([
      ['os.comment-draft.u1.c1.root', '{}'],
      ['os.comment-draft.u2.c9.r1', '{}'],
      ['os.feed-settings', '{}'],
    ]);
    const storage = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    clearDrafts(storage);
    expect([...store.keys()]).toEqual(['os.feed-settings']);
  });
});

describe('isUnavailableCode', () => {
  it('names the codes that mean the item is gone for this viewer (not generic not_found)', () => {
    for (const c of ['content_not_found', 'stale_version', 'not_published']) {
      expect(isUnavailableCode(c), c).toBe(true);
    }
    for (const c of ['not_found', 'comments_disabled', 'rate_limited', 'csrf', undefined]) {
      expect(isUnavailableCode(c), String(c)).toBe(false);
    }
  });
});
