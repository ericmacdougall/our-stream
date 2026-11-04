// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { initialLike, reduceLike, type LikeState } from './reactions.js';

const base = initialLike({ liked: false, likeCount: 3 });

describe('reduceLike: optimistic like/unlike with one request in flight', () => {
  it('flips optimistically and asks for exactly one request on the first click', () => {
    const { state, send } = reduceLike(base, { type: 'click' });
    expect(state.liked).toBe(true);
    expect(state.likeCount).toBe(4);
    expect(state.phase).toBe('pending');
    expect(send).toEqual({ liked: true, attempt: 1 });
  });
  it('a second click while pending flips the intent but sends nothing (double-click = one request)', () => {
    const first = reduceLike(base, { type: 'click' });
    const second = reduceLike(first.state, { type: 'click' });
    expect(second.send).toBeUndefined();
    expect(second.state.liked).toBe(false);
    expect(second.state.likeCount).toBe(3);
    expect(second.state.phase).toBe('pending');
  });
  it('settles to the server answer when the intent matches what was sent', () => {
    const first = reduceLike(base, { type: 'click' });
    const settled = reduceLike(first.state, { type: 'settled', liked: true, likeCount: 10 });
    expect(settled.state).toMatchObject({ liked: true, likeCount: 10, phase: 'idle' });
    expect(settled.send).toBeUndefined();
  });
  it('sends the queued intent once the first request settles (click, click, settle -> one more request)', () => {
    const first = reduceLike(base, { type: 'click' });
    const second = reduceLike(first.state, { type: 'click' });
    const settled = reduceLike(second.state, { type: 'settled', liked: true, likeCount: 4 });
    expect(settled.send).toEqual({ liked: false, attempt: 1 });
    expect(settled.state.phase).toBe('pending');
    // Optimistic count is derived from the server count, not from a stale local one.
    expect(settled.state.likeCount).toBe(3);
    expect(settled.state.liked).toBe(false);
  });
  it('rolls back to the last server-known state on a definite failure', () => {
    const first = reduceLike(base, { type: 'click' });
    const failed = reduceLike(first.state, { type: 'failed', definite: true });
    expect(failed.state).toMatchObject({ liked: false, likeCount: 3, phase: 'idle' });
    expect(failed.send).toBeUndefined();
  });
  it('retries the identical request after a lost response (idempotent on the server), at most 3 attempts', () => {
    let s: LikeState = reduceLike(base, { type: 'click' }).state;
    const r1 = reduceLike(s, { type: 'failed', definite: false });
    expect(r1.send).toEqual({ liked: true, attempt: 2 });
    s = r1.state;
    const r2 = reduceLike(s, { type: 'failed', definite: false });
    expect(r2.send).toEqual({ liked: true, attempt: 3 });
    const r3 = reduceLike(r2.state, { type: 'failed', definite: false });
    expect(r3.send).toBeUndefined();
    expect(r3.state).toMatchObject({ liked: false, likeCount: 3, phase: 'idle' });
  });
  it('never lets the count go negative', () => {
    const zero = initialLike({ liked: true, likeCount: 0 });
    expect(reduceLike(zero, { type: 'click' }).state.likeCount).toBe(0);
  });
  it('a server refresh (feed reload) replaces state only when idle', () => {
    const pending = reduceLike(base, { type: 'click' }).state;
    expect(reduceLike(pending, { type: 'refresh', liked: false, likeCount: 7 }).state).toBe(
      pending,
    );
    expect(reduceLike(base, { type: 'refresh', liked: true, likeCount: 7 }).state).toMatchObject({
      liked: true,
      likeCount: 7,
    });
  });
});
