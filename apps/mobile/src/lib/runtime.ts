// SPDX-License-Identifier: Apache-2.0
// Process-wide instances wired to the real storage backends.
import { createTracker } from './engagement';
import { newId } from './ids';
import { plainStore } from './storage';

export const tracker = createTracker({ store: plainStore, newKey: newId });

/** Development builds may talk to a local API over plain http (loopback only, see discovery.ts). */
export const ALLOW_LOOPBACK_HTTP: boolean = typeof __DEV__ !== 'undefined' && __DEV__;
