// SPDX-License-Identifier: AGPL-3.0-only
/** Try-acquire semaphore: never waits. `tryAcquire` returns a release function or null when full. */
export class TrySemaphore {
  private inUse = 0;
  constructor(private readonly capacity: number) {}

  tryAcquire(): (() => void) | null {
    if (this.inUse >= this.capacity) return null;
    this.inUse += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse -= 1;
    };
  }

  get active(): number {
    return this.inUse;
  }
}
