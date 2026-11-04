// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Binds the optimistic like machine (reactions.ts) to the adapter: one request in flight, queued
// intent, identical retry on a lost response, rollback on refusal, item removal when the server
// says the clip is gone.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isUnavailableCode } from './comments';
import { setLike } from './api';
import {
  initialLike,
  reduceLike,
  type LikeEvent,
  type LikeSend,
  type LikeState,
} from './reactions';

export function useLike(
  contentId: string,
  server: { liked: boolean; likeCount: number },
  onUnavailable?: () => void,
) {
  const [state, setState] = useState<LikeState>(() => initialLike(server));
  const stateRef = useRef(state);
  stateRef.current = state;
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  const send = useCallback(
    async (request: LikeSend) => {
      const result = await setLike(contentId, request.liked);
      let event: LikeEvent;
      if (result.ok) {
        event = { type: 'settled', liked: result.data.liked, likeCount: result.data.likeCount };
      } else {
        if (isUnavailableCode(result.code)) unavailableRef.current?.();
        event = { type: 'failed', definite: !result.lost };
      }
      const out = reduceLike(stateRef.current, event);
      stateRef.current = out.state;
      setState(out.state);
      if (out.send) void send(out.send);
    },
    [contentId],
  );

  const toggle = useCallback(() => {
    const out = reduceLike(stateRef.current, { type: 'click' });
    stateRef.current = out.state;
    setState(out.state);
    if (out.send) void send(out.send);
  }, [send]);

  // A feed refresh brings new server counts; they replace local state only when idle.
  useEffect(() => {
    const out = reduceLike(stateRef.current, {
      type: 'refresh',
      liked: server.liked,
      likeCount: server.likeCount,
    });
    stateRef.current = out.state;
    setState(out.state);
  }, [server.liked, server.likeCount]);

  return {
    liked: state.liked,
    likeCount: state.likeCount,
    pending: state.phase === 'pending',
    toggle,
  };
}
