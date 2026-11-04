// SPDX-License-Identifier: AGPL-3.0-only
// Optimistic like/unlike state machine. The server calls are idempotent (POST like -> liked, DELETE
// -> unliked, both answer the resulting state), so the rules are: at most one request in flight per
// item; a click while pending only changes the intent (a double click is one request); when the
// request settles and the intent differs from what was sent, one more request carries the intent;
// a lost response is retried unchanged up to three attempts; a definite refusal rolls back to the
// last server-known state. Counts are always derived from the server count, never from a local one.
const MAX_ATTEMPTS = 3;

interface ServerLike {
  liked: boolean;
  likeCount: number;
}

export interface LikeState {
  liked: boolean;
  likeCount: number;
  phase: 'idle' | 'pending';
  /** The `liked` value the in-flight request asks for (null when idle). */
  sent: boolean | null;
  attempt: number;
  server: ServerLike;
}

export type LikeEvent =
  | { type: 'click' }
  | { type: 'settled'; liked: boolean; likeCount: number }
  | { type: 'failed'; definite: boolean }
  | { type: 'refresh'; liked: boolean; likeCount: number };

export interface LikeSend {
  liked: boolean;
  attempt: number;
}

export function initialLike(server: ServerLike): LikeState {
  return {
    liked: server.liked,
    likeCount: server.likeCount,
    phase: 'idle',
    sent: null,
    attempt: 0,
    server: { ...server },
  };
}

function optimisticCount(server: ServerLike, liked: boolean): number {
  if (liked === server.liked) return server.likeCount;
  return Math.max(0, server.likeCount + (liked ? 1 : -1));
}

export function reduceLike(
  state: LikeState,
  event: LikeEvent,
): { state: LikeState; send?: LikeSend } {
  switch (event.type) {
    case 'click': {
      const liked = !state.liked;
      const likeCount = optimisticCount(state.server, liked);
      if (state.phase === 'pending') return { state: { ...state, liked, likeCount } };
      return {
        state: { ...state, liked, likeCount, phase: 'pending', sent: liked, attempt: 1 },
        send: { liked, attempt: 1 },
      };
    }
    case 'settled': {
      if (state.phase !== 'pending') return { state };
      const server = { liked: event.liked, likeCount: event.likeCount };
      if (state.liked === state.sent) {
        return { state: { ...initialLike(server) } };
      }
      // The intent moved while the request was in flight: send it now.
      const liked = state.liked;
      return {
        state: {
          ...state,
          server,
          liked,
          likeCount: optimisticCount(server, liked),
          phase: 'pending',
          sent: liked,
          attempt: 1,
        },
        send: { liked, attempt: 1 },
      };
    }
    case 'failed': {
      if (state.phase !== 'pending') return { state };
      if (!event.definite && state.attempt < MAX_ATTEMPTS && state.sent !== null) {
        const attempt = state.attempt + 1;
        return { state: { ...state, attempt }, send: { liked: state.sent, attempt } };
      }
      return { state: initialLike(state.server) };
    }
    case 'refresh':
      if (state.phase !== 'idle') return { state };
      return { state: initialLike({ liked: event.liked, likeCount: event.likeCount }) };
  }
}
