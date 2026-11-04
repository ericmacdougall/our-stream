// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { CommentThread } from './comments';
import {
  applyRemoved,
  editDraft,
  insertReply,
  mergeThreads,
  newDraft,
  replyTarget,
  validateCommentBody,
} from './comments';

const author = { id: '00000000-0000-4000-8000-000000000001', displayName: 'Ann' };
function thread(id: string, replies: CommentThread['replies'] = []): CommentThread {
  return {
    id,
    contentId: 'c',
    parentId: null,
    author,
    body: `root ${id}`,
    state: 'visible',
    createdAt: '2026-01-01T00:00:00Z',
    removedAt: null,
    canRemove: false,
    replies,
    replyCount: replies.length,
  };
}
function reply(id: string, parentId: string): CommentThread['replies'][number] {
  const { replies: _r, replyCount: _c, ...node } = thread(id);
  return { ...node, parentId, body: `reply ${id}` };
}

describe('validateCommentBody', () => {
  it('trims and enforces 1..2000 UTF-16 units', () => {
    expect(validateCommentBody('  hi  ')).toBe('hi');
    expect(validateCommentBody('   ')).toBeNull();
    expect(validateCommentBody('a'.repeat(2000))).toHaveLength(2000);
    expect(validateCommentBody('a'.repeat(2001))).toBeNull();
    expect(validateCommentBody('🎉'.repeat(1000))).toHaveLength(2000);
    expect(validateCommentBody('🎉'.repeat(1001))).toBeNull();
  });
});

describe('newDraft', () => {
  it('fixes the idempotency key when the draft starts, not when it is sent', () => {
    const d = newDraft(() => 'key-1', 'root-1');
    expect(d).toEqual({ clientKey: 'key-1', parentId: 'root-1', body: '' });
  });
  it('rotates the key when the payload changes and keeps it for an identical retry', () => {
    let n = 1;
    const key = () => `key-${++n}`;
    const d = newDraft(() => 'key-1', null);
    const typed = editDraft(d, { body: 'hello' }, key);
    expect(typed).toEqual({ clientKey: 'key-2', parentId: null, body: 'hello' });
    expect(editDraft(typed, { body: 'hello' }, key)).toBe(typed);
    expect(editDraft(typed, { parentId: 'r1' }, key).clientKey).toBe('key-3');
  });
  it('resolves the root to reply to', () => {
    const list = [thread('r1', [reply('a', 'r1')])];
    expect(replyTarget(list, 'r1')).toBe('r1');
    expect(replyTarget(list, 'a')).toBe('r1');
    expect(replyTarget(list, 'zz')).toBeNull();
  });
});

describe('thread updates', () => {
  it('appends a reply under its root and bumps the count', () => {
    const list = [thread('r1'), thread('r2')];
    const out = insertReply(list, reply('x', 'r2'));
    expect(out[1]?.replies.map((r) => r.id)).toEqual(['x']);
    expect(out[1]?.replyCount).toBe(1);
    expect(out[0]).toBe(list[0]);
  });
  it('inserts a new root at the top and dedupes on merge', () => {
    const list = [thread('r1')];
    const out = insertReply(list, thread('r0'));
    expect(out.map((t) => t.id)).toEqual(['r0', 'r1']);
    expect(mergeThreads(out, [thread('r1'), thread('r2')]).map((t) => t.id)).toEqual([
      'r0',
      'r1',
      'r2',
    ]);
  });
  it('replaces a root or a reply with its tombstone', () => {
    const list = [thread('r1', [reply('a', 'r1'), reply('b', 'r1')])];
    const gone = {
      ...reply('b', 'r1'),
      state: 'removed' as const,
      body: null,
      author: null,
      removedAt: '2026-01-02T00:00:00Z',
    };
    const out = applyRemoved(list, gone);
    expect(out[0]?.replies[1]).toEqual(gone);
    expect(out[0]?.replies[0]?.state).toBe('visible');
    const rootGone = {
      ...thread('r1'),
      state: 'removed' as const,
      body: null,
      author: null,
      removedAt: '2026-01-02T00:00:00Z',
    };
    const out2 = applyRemoved(out, rootGone);
    expect(out2[0]?.state).toBe('removed');
    expect(out2[0]?.replies).toHaveLength(2);
  });
});
