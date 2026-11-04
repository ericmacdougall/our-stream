// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

// Pure modules only (src/lib): nothing under test imports React Native or Expo runtime modules.
export default defineConfig({ test: { include: ['src/lib/**/*.test.ts'] } });
