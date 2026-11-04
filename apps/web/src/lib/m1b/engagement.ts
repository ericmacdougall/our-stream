// SPDX-License-Identifier: AGPL-3.0-only
// Engagement milestone tracker (ADR-0006, M1b contract). Model: position-based crossing during
// continuous playback. A milestone (25/50/75 % of the duration) fires once per playback session when
// consecutive time updates move from below to at-or-above the threshold with no seek in between; a
// seek only moves the continuity point, so thresholds skipped by a seek do not fire and a seek alone
// never fires anything. Nothing is counted while the player is paused or while the item is not
// eligible (not the active visible feed item, or the document is hidden). `view_start` fires once per
// session when eligible playback begins; `complete` fires once on ended; the next play after a
// completion mints a new session key (the server derives the rewatch). A version change resets all.
import type { z } from 'zod';
import type { EngagementType } from '@our-stream/contracts';

export type MilestoneType = z.output<typeof EngagementType>;

export interface EngagementState {
  versionId: string;
  durationMs: number | null;
  sessionKey: string | null;
  fired: ReadonlySet<MilestoneType>;
  playing: boolean;
  eligible: boolean;
  completed: boolean;
  /** Last position seen (any state); the continuity point for the next crossing check. */
  lastPositionMs: number | null;
}

export type EngagementStep =
  | { type: 'eligible'; value: boolean }
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'time'; positionMs: number }
  | { type: 'seeked'; positionMs: number }
  | { type: 'ended' }
  | { type: 'version'; versionId: string; durationMs: number | null }
  | { type: 'duration'; durationMs: number | null };

export interface EngagementEvent {
  type: MilestoneType;
  sessionKey: string;
  versionId: string;
  positionMs: number;
}

const THRESHOLDS: readonly { type: MilestoneType; pct: number }[] = [
  { type: 'progress_25', pct: 25 },
  { type: 'progress_50', pct: 50 },
  { type: 'progress_75', pct: 75 },
];

export function initialEngagement(input: {
  versionId: string;
  durationMs: number | null;
}): EngagementState {
  return {
    versionId: input.versionId,
    durationMs: input.durationMs,
    sessionKey: null,
    fired: new Set(),
    playing: false,
    eligible: false,
    completed: false,
    lastPositionMs: null,
  };
}

type Out = { state: EngagementState; events: EngagementEvent[] };

function emit(state: EngagementState, type: MilestoneType, positionMs: number): Out {
  if (!state.sessionKey || state.fired.has(type)) return { state, events: [] };
  const fired = new Set(state.fired);
  fired.add(type);
  return {
    state: { ...state, fired },
    events: [{ type, sessionKey: state.sessionKey, versionId: state.versionId, positionMs }],
  };
}

/** Starts a session if needed (a new one after a completion) and fires view_start once. */
function beginIfEligible(state: EngagementState, mint: () => string): Out {
  if (!state.playing || !state.eligible) return { state, events: [] };
  let s = state;
  if (s.completed || s.sessionKey === null) {
    s = { ...s, sessionKey: mint(), fired: new Set(), completed: false };
  }
  return emit(s, 'view_start', s.lastPositionMs ?? 0);
}

export function reduceEngagement(
  state: EngagementState,
  step: EngagementStep,
  mint: () => string,
): Out {
  switch (step.type) {
    case 'eligible': {
      if (step.value === state.eligible) return { state, events: [] };
      const s = { ...state, eligible: step.value };
      return step.value ? beginIfEligible(s, mint) : { state: s, events: [] };
    }
    case 'playing':
      return beginIfEligible({ ...state, playing: true }, mint);
    case 'paused':
      return { state: { ...state, playing: false }, events: [] };
    case 'seeked':
      // A seek moves the continuity point; by itself it never fires a milestone.
      return { state: { ...state, lastPositionMs: step.positionMs }, events: [] };
    case 'time': {
      const prev = state.lastPositionMs;
      const next = { ...state, lastPositionMs: step.positionMs };
      if (!state.playing || !state.eligible || !state.sessionKey)
        return { state: next, events: [] };
      if (prev === null || step.positionMs < prev) return { state: next, events: [] };
      if (state.durationMs === null || state.durationMs <= 0) return { state: next, events: [] };
      let out: Out = { state: next, events: [] };
      for (const { type, pct } of THRESHOLDS) {
        const at = (state.durationMs * pct) / 100;
        if (prev < at && step.positionMs >= at) {
          const fired = emit(out.state, type, step.positionMs);
          out = { state: fired.state, events: [...out.events, ...fired.events] };
        }
      }
      return out;
    }
    case 'ended': {
      const s = { ...state, playing: false };
      if (!s.eligible || !s.sessionKey) return { state: { ...s, completed: true }, events: [] };
      const fired = emit(s, 'complete', s.durationMs ?? s.lastPositionMs ?? 0);
      return { state: { ...fired.state, completed: true }, events: fired.events };
    }
    case 'version':
      return {
        state: {
          ...initialEngagement({ versionId: step.versionId, durationMs: step.durationMs }),
          eligible: state.eligible,
        },
        events: [],
      };
    case 'duration':
      return { state: { ...state, durationMs: step.durationMs }, events: [] };
  }
}
