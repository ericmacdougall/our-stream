// SPDX-License-Identifier: AGPL-3.0-only
// Mobile sign-in handoff (GoodQA work-tracker-automatic#35644): /magic?token=..&app=1 must not
// consume the token and must offer the ourstream:// link for this server; without app=1 the
// explicit-press consume is unchanged.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const TOKEN = 'h4ndoff-T0ken_value.0123456789~abcdef';
const CONSUME = '/v1/auth/magic-link/consume';

test('app=1 hands the token to the app and never consumes it', async ({ page, baseURL }) => {
  const consumes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(CONSUME)) consumes.push(r.url());
  });
  const response = await page.goto(`/magic?token=${TOKEN}&app=1`);

  await expect(page.getByRole('heading', { name: 'Continue in the our-stream app' })).toBeVisible();
  const link = page.getByRole('link', { name: 'Open in the our-stream app' });
  await expect(link).toHaveAttribute(
    'href',
    `ourstream://magic?token=${TOKEN}&server=${encodeURIComponent(baseURL ?? '')}`,
  );
  expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  await expect(page.getByText('only works on the device that requested it')).toBeVisible();
  // The token is never displayed.
  await expect(page.locator('body')).not.toContainText(TOKEN);
  // No sign-in button: this page does not consume.
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

  const serious = (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze()
  ).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => v.id)).toEqual([]);

  // Settle: nothing was sent, and still nothing after a pause (no deferred consume).
  await page.waitForTimeout(500);
  expect(consumes).toEqual([]);
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
});

test('app=1 with a malformed token or app value is not a handoff', async ({ page }) => {
  await page.goto('/magic?token=short&app=1');
  await expect(page.getByText('This link is missing or incomplete')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in the our-stream app' })).toHaveCount(0);
  await page.goto(`/magic?token=${TOKEN}&app=true`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in the our-stream app' })).toHaveCount(0);
});

test('without app=1 the page still consumes on an explicit press', async ({ page }) => {
  const consumes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(CONSUME)) consumes.push(r.url());
  });
  await page.goto(`/magic?token=${TOKEN}`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(consumes).toEqual([]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => consumes.length).toBe(1);
});
