// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// One playback hook for every player (feed item, search hit, content page): drives the engagement
// tracker (engagement.ts: continuous-playback crossings only, never a seek, nothing while the item
// is not the eligible active one or the tab is hidden) and the M1a /view record (view_start on the
// first eligible play, complete on ended) that keeps retraction targeting working. Each event is
// sent with its (session, content, version, type) key and retried identically up to three times.
import { useCallback, useEffect, useRef, useState } from 'react';
import { browserApi } from '@/lib/api/client';
import { mintClientKey, sendEngagement } from './api';
import {
  initialEngagement,
  reduceEngagement,
  type EngagementEvent,
  type EngagementState,
  type EngagementStep,
} from './engagement';

const MAX_ATTEMPTS = 3;

/** True while the document is visible (tab in the foreground). */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

export interface PlaybackHandlers {
  onPlaying: () => void;
  onPause: () => void;
  onEnded: () => void;
  onTimeMs: (ms: number) => void;
  onSeeked: (ms: number) => void;
  onDurationMs: (ms: number | null) => void;
}

export function usePlaybackEngagement(input: {
  contentId: string;
  versionId: string;
  durationMs: number | null;
  /** The active, on-screen player in a visible tab. Nothing is counted otherwise. */
  eligible: boolean;
}): PlaybackHandlers {
  const { contentId, versionId, durationMs, eligible } = input;
  const stateRef = useRef<EngagementState>(initialEngagement({ versionId, durationMs }));
  const viewStarted = useRef(false);
  const viewCompleted = useRef(false);

  const sendView = useCallback(
    async (completed: boolean) => {
      const flag = completed ? viewCompleted : viewStarted;
      if (flag.current) return;
      flag.current = true;
      try {
        const result = await browserApi().POST('/v1/content/{id}/view', {
          params: { path: { id: contentId } },
          body: { versionId, completed },
        });
        if (result.response.status >= 500) flag.current = false;
      } catch {
        flag.current = false;
      }
    },
    [contentId, versionId],
  );

  const deliver = useCallback(
    async (event: EngagementEvent, attempt = 1) => {
      const result = await sendEngagement(contentId, {
        versionId: event.versionId,
        sessionKey: event.sessionKey,
        type: event.type,
        positionMs: Math.min(2_147_483_647, Math.max(0, Math.round(event.positionMs))),
      });
      if (!result.ok && result.lost && attempt < MAX_ATTEMPTS) {
        void deliver(event, attempt + 1);
      }
    },
    [contentId],
  );

  const step = useCallback(
    (s: EngagementStep) => {
      const before = stateRef.current.sessionKey;
      const out = reduceEngagement(stateRef.current, s, mintClientKey);
      stateRef.current = out.state;
      // A new playback session (first play, or a replay after complete) gets its own /view record.
      if (out.state.sessionKey !== before) {
        viewStarted.current = false;
        viewCompleted.current = false;
      }
      for (const event of out.events) {
        if (event.type === 'view_start') void sendView(false);
        if (event.type === 'complete') void sendView(true);
        void deliver(event);
      }
    },
    [deliver, sendView],
  );

  useEffect(() => {
    step({ type: 'eligible', value: eligible });
  }, [eligible, step]);

  useEffect(() => {
    if (stateRef.current.versionId !== versionId) {
      step({ type: 'version', versionId, durationMs });
      viewStarted.current = false;
      viewCompleted.current = false;
    } else if (stateRef.current.durationMs !== durationMs && durationMs !== null) {
      step({ type: 'duration', durationMs });
    }
  }, [versionId, durationMs, step]);

  return {
    onPlaying: useCallback(() => step({ type: 'playing' }), [step]),
    onPause: useCallback(() => step({ type: 'paused' }), [step]),
    onEnded: useCallback(() => step({ type: 'ended' }), [step]),
    onTimeMs: useCallback((ms: number) => step({ type: 'time', positionMs: ms }), [step]),
    onSeeked: useCallback((ms: number) => step({ type: 'seeked', positionMs: ms }), [step]),
    onDurationMs: useCallback(
      (ms: number | null) => {
        // The contract's duration wins when known; the media's own value fills a null.
        if (stateRef.current.durationMs === null && ms !== null)
          step({ type: 'duration', durationMs: ms });
      },
      [step],
    ),
  };
}
