// SPDX-License-Identifier: AGPL-3.0-only
// Minimal in-process counters. `authz.leak_check_failed` is created in M2a: it increments when the
// independent reference check disagrees with the SQL predicate or cannot run (fail closed). The names are
// the contract; an exporter can read `snapshotCounters()`.
const counters = new Map<string, number>();

export const LEAK_CHECK_FAILED = 'authz.leak_check_failed';

export function incrementCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function readCounter(name: string): number {
  return counters.get(name) ?? 0;
}

export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}
