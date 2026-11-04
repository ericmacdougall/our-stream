// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isoToLocalDateTime, localDateTimeToIso } from './schedule.js';

describe('localDateTimeToIso', () => {
  it('interprets datetime-local as the viewer zone and emits ISO UTC', () => {
    const iso = localDateTimeToIso('2026-11-03T09:30');
    expect(iso).not.toBeNull();
    const d = new Date(iso as string);
    // Whatever the test machine's zone, the local components round-trip.
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
    expect(d.getDate()).toBe(3);
    expect(iso).toMatch(/Z$/);
  });
  it('round-trips through isoToLocalDateTime at minute precision', () => {
    const local = '2026-03-29T02:30';
    const iso = localDateTimeToIso(local);
    expect(iso).not.toBeNull();
    const back = isoToLocalDateTime(iso as string);
    // Across a DST gap the wall-clock may shift by an hour; the date must survive.
    expect(back.slice(0, 10)).toBe('2026-03-29');
    expect(isoToLocalDateTime(localDateTimeToIso('2026-11-03T09:30') as string)).toBe(
      '2026-11-03T09:30',
    );
  });
  it('rejects malformed and impossible values', () => {
    for (const bad of ['', '2026-11-03', '2026-13-01T00:00', '2026-02-31T10:00', 'tomorrow']) {
      expect(localDateTimeToIso(bad), bad).toBeNull();
    }
    expect(isoToLocalDateTime('nope')).toBe('');
  });
});
