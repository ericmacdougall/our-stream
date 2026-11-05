// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'], testTimeout: 60_000 } },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.ts'],
          testTimeout: 900_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
