// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  initialEngagement,
  reduceEngagement,
  type EngagementEvent,
  type EngagementState,
} from './engagement.js';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
let keys = 0;
const mint = () => `s${++keys}`;

function run(
  state: EngagementState,
  steps: Parameters<typeof reduceEngagement>[1][],
): { state: EngagementState; events: EngagementEvent[] } {
  const events: EngagementEvent[] = [];
  let s = state;
  for (const step of steps) {
    const out = reduceEngagement(s, step, mint);
    s = out.state;
    events.push(...out.events);
  }
  return { state: s, events };
}

const start = () => initialEngagement({ versionId: V1, durationMs: 100_000 });
const types = (events: EngagementEvent[]) => events.map((e) => e.type);

describe('engagement milestones', () => {
  it('fires view_start once on first playback and each milestone once on continuous crossing', () => {
    const { events } = run(start(), [
      { type: 'eligible', value: true },
      { type: 'playing' },
      { type: 'time', positionMs: 1_000 },
      { type: 'time', positionMs: 24_000 },
      { type: 'time', positionMs: 25_200 },
      { type: 'time', positionMs: 26_000 },
      { type: 'time', positionMs: 49_900 },
      { type: 'time', positionMs: 50_100 },
      { type: 'time', positionMs: 74_900 },
      { type: 'time', positionMs: 75_100 },
      { type: 'ended' },
    ]);
    expect(types(events)).toEqual([
      'view_start',
      'progress_25',
      'progress_50',
      'progress_75',
      'complete',
    ]);
    const key = events[0]?.sessionKey;
    expect(key).toBeTruthy();
    for (const e of events) {
      expect(e.sessionKey).toBe(key);
      expect(e.versionId).toBe(V1);
    }
    expect(events[1]?.positionMs).toBe(25_200);
  });
  it('never fires a milestone from a seek: a jump past 50 % fires nothing until playback crosses the next threshold', () => {
    const { events } = run(start(), [
      { type: 'eligible', value: true },
      { type: 'playing' },
      { type: 'time', positionMs: 1_000 },
      // The viewer drags the scrubber to 60 %: the position jumps.
      { type: 'seeked', positionMs: 60_000 },
      { type: 'time', positionMs: 60_000 },
      { type: 'time', positionMs: 61_000 },
      { type: 'time', positionMs: 74_800 },
      { type: 'time', positionMs: 75_300 },
    ]);
    expect(types(events)).toEqual(['view_start', 'progress_75']);
  });
  it('seeking back and forth across a threshold fires it only once', () => {
    const { events } = run(start(), [
      { type: 'eligible', value: true },
      { type: 'playing' },
      { type: 'time', positionMs: 24_500 },
      { type: 'time', positionMs: 25_500 },
      { type: 'seeked', positionMs: 10_000 },
      { type: 'time', positionMs: 10_000 },
      { type: 'time', positionMs: 24_600 },
      { type: 'time', positionMs: 25_600 },
      { type: 'seeked', positionMs: 5_000 },
      { type: 'time', positionMs: 24_700 },
      { type: 'time', positionMs: 25_700 },
    ]);
    expect(types(events)).toEqual(['view_start', 'progress_25']);
  });
  it('a seek while paused fires nothing, and so does time while paused', () => {
    const { events } = run(start(), [
      { type: 'eligible', value: true },
      { type: 'seeked', positionMs: 80_000 },
      { type: 'time', positionMs: 80_000 },
      { type: 'time', positionMs: 80_500 },
    ]);
    expect(events).toEqual([]);
  });
  it('emits nothing while ineligible (inactive item or hidden tab) and resumes without back-filling', () => {
    const { events } = run(start(), [
      { type: 'playing' }, // not eligible yet: muted autoplay off-screen
      { type: 'time', positionMs: 30_000 },
      { type: 'eligible', value: true },
      { type: 'time', positionMs: 30_500 },
      { type: 'time', positionMs: 49_900 },
      { type: 'time', positionMs: 50_100 },
      { type: 'eligible', value: false }, // tab hidden
      { type: 'time', positionMs: 74_900 },
      { type: 'time', positionMs: 75_100 },
      { type: 'eligible', value: true },
      { type: 'time', positionMs: 76_000 },
    ]);
    // view_start when it first became eligible while playing; 25 % was never crossed while counted.
    expect(types(events)).toEqual(['view_start', 'progress_50']);
  });
  it('replaying after complete mints a new session (server derives the rewatch)', () => {
    const first = run(start(), [
      { type: 'eligible', value: true },
      { type: 'playing' },
      { type: 'time', positionMs: 99_000 },
      { type: 'ended' },
    ]);
    const second = run(first.state, [
      { type: 'playing' },
      { type: 'time', positionMs: 500 },
      { type: 'time', positionMs: 24_900 },
      { type: 'time', positionMs: 25_100 },
    ]);
    expect(types(second.events)).toEqual(['view_start', 'progress_25']);
    expect(second.events[0]?.sessionKey).not.toBe(first.events[0]?.sessionKey);
  });
  it('a version change resets the session and the fired set', () => {
    const first = run(start(), [
      { type: 'eligible', value: true },
      { type: 'playing' },
      { type: 'time', positionMs: 24_000 },
      { type: 'time', positionMs: 26_000 },
    ]);
    const next = run(first.state, [
      { type: 'version', versionId: V2, durationMs: 50_000 },
      { type: 'playing' },
      { type: 'time', positionMs: 12_000 },
      { type: 'time', positionMs: 13_000 },
    ]);
    expect(types(next.events)).toEqual(['view_start', 'progress_25']);
    expect(next.events[0]?.versionId).toBe(V2);
    expect(next.events[0]?.sessionKey).not.toBe(first.events[0]?.sessionKey);
  });
  it('without a known duration only view_start and complete can fire', () => {
    const { events } = run(initialEngagement({ versionId: V1, durationMs: null }), [
      { type: 'eligible', value: true },
      { type: 'playing' },
      { type: 'time', positionMs: 10 },
      { type: 'time', positionMs: 10_000_000 },
      { type: 'ended' },
    ]);
    expect(types(events)).toEqual(['view_start', 'complete']);
  });
  it('complete fires once even if ended repeats', () => {
    const { events } = run(start(), [
      { type: 'eligible', value: true },
      { type: 'playing' },
      { type: 'ended' },
      { type: 'ended' },
    ]);
    expect(types(events)).toEqual(['view_start', 'complete']);
  });
});
