// SPDX-License-Identifier: AGPL-3.0-only
// Request budgets that do not depend on the client address. The per-IP budgets (here and the
// @fastify/rate-limit per-route limit on auth routes) are only as good as TRUST_PROXY: a hop that
// forwards X-Forwarded-For without appending its peer (Next.js rewrites do this) lets a client choose
// its own address, so every authenticated or account-bound budget is keyed by a VALIDATED identity:
// the session id after lookup, the user id carried by a verified media token, or the normalised
// email an auth route is acting on. In-memory fixed windows, per process; a shared store (Valkey) is
// an M2+ concern for multi-instance deployments (ADR-0004).
import type { Config } from '../config.js';

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, { n: number; reset: number }>();
  private lastPrune = 0;
  constructor(private readonly opts: { max: number; windowMs: number }) {}

  allow(key: string, now = Date.now()): boolean {
    if (now - this.lastPrune > this.opts.windowMs) this.prune(now);
    const b = this.buckets.get(key);
    if (!b || b.reset <= now) {
      this.buckets.set(key, { n: 1, reset: now + this.opts.windowMs });
      return true;
    }
    b.n += 1;
    return b.n <= this.opts.max;
  }

  private prune(now: number): void {
    this.lastPrune = now;
    for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
  }
}

export interface Limiters {
  /** Unauthenticated traffic (public routes, requests without a valid session), by client address. */
  ip: FixedWindowLimiter;
  /** Authenticated traffic, by validated session id. */
  session: FixedWindowLimiter;
  /** Media served to a verified media token, by the user id the token carries. */
  media: FixedWindowLimiter;
  /** Signup, login and magic-link requests, by the normalised email they act on. */
  email: FixedWindowLimiter;
}

export function createLimiters(config: Config): Limiters {
  const windowMs = 60_000;
  return {
    ip: new FixedWindowLimiter({ max: config.IP_RATE_LIMIT_MAX, windowMs }),
    session: new FixedWindowLimiter({ max: config.SESSION_RATE_LIMIT_MAX, windowMs }),
    media: new FixedWindowLimiter({ max: config.MEDIA_RATE_LIMIT_MAX, windowMs }),
    email: new FixedWindowLimiter({ max: config.AUTH_EMAIL_RATE_LIMIT_MAX, windowMs }),
  };
}
