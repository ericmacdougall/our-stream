// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from './limits.js';

describe('FixedWindowLimiter', () => {
  it('allows max requests per window per key, then refuses until the window resets', () => {
    const l = new FixedWindowLimiter({ max: 3, windowMs: 1000 });
    expect([l.allow('a', 0), l.allow('a', 1), l.allow('a', 2), l.allow('a', 3)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(l.allow('b', 3)).toBe(true); // other keys are independent
    expect(l.allow('a', 1001)).toBe(true); // window reset
  });

  it('prunes expired buckets so long-running processes do not grow without bound', () => {
    const l = new FixedWindowLimiter({ max: 1, windowMs: 10 });
    for (let i = 0; i < 1000; i += 1) l.allow(`k${i}`, 0);
    l.allow('late', 1000);
    expect((l as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(1);
  });
});
