// SPDX-License-Identifier: Apache-2.0
// Random ids for idempotency keys and playback session keys (contract: opaque, 1..64 chars).
import * as Crypto from 'expo-crypto';

export function newId(): string {
  return Crypto.randomUUID();
}
