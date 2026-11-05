// SPDX-License-Identifier: Apache-2.0
// expo-crypto adapter for the magic-link verifier (the pure logic is in magic-verifier.ts).
import * as Crypto from 'expo-crypto';
import type { MagicCrypto } from './magic-verifier';

export const magicCrypto: MagicCrypto = {
  randomBytes: (length) => Crypto.getRandomBytes(length),
  sha256: async (data) =>
    new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(data))),
};
