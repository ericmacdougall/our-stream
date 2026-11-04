// SPDX-License-Identifier: AGPL-3.0-only
// E2E against the in-repo mock API by default; set E2E_API_URL to run the same suite against a real
// API (the web app is built with that URL as its /api and /media rewrite target).
import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env['E2E_WEB_PORT'] ?? 3100);
const mockPort = Number(process.env['E2E_MOCK_PORT'] ?? 4100);
const realApi = process.env['E2E_API_URL'];
const apiUrl = realApi ?? `http://127.0.0.1:${mockPort}`;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env['E2E_BROWSER_CHANNEL'] ? { channel: process.env['E2E_BROWSER_CHANNEL'] } : {}),
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    ...(realApi
      ? []
      : [
          {
            command: 'node test/mock-api/server.mjs',
            url: `${apiUrl}/health`,
            reuseExistingServer: !process.env['CI'],
            timeout: 60_000,
            env: {
              PORT: String(mockPort),
              HOST: '127.0.0.1',
              ...(process.env['MOCK_MEDIA'] ? { MOCK_MEDIA: process.env['MOCK_MEDIA'] } : {}),
            },
          },
        ]),
    {
      command: process.env['E2E_SKIP_BUILD']
        ? `pnpm exec next start -p ${webPort}`
        : `node scripts/build-sw.mjs && pnpm exec next build && pnpm exec next start -p ${webPort}`,
      url: baseURL + '/sign-in',
      reuseExistingServer: !process.env['CI'],
      timeout: 300_000,
      env: { API_INTERNAL_URL: apiUrl, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
