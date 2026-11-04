// SPDX-License-Identifier: AGPL-3.0-only
// Regression: React hydration error #418 (server/client text mismatch) on feed loads, seen in the
// M1b click test at the feed and its filtered variants.
import { expect, test } from '@playwright/test';
import { publishToEveryone, signUp, uniqueAccount, uploadClip } from './helpers';

const HYDRATION = /hydrat|#418|react\.dev\/errors\/418|did not match/i;

test('feed and filtered feeds hydrate without a text mismatch', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));

  await signUp(page, uniqueAccount('hydr'));
  const id = await uploadClip(page, 'Hydration clip');
  await publishToEveryone(page, id);

  for (const path of ['/', '/?tag=training', '/?pinned=true', '/?tag=onboarding&pinned=true']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Feed', includeHidden: true })).toBeAttached();
    // Give hydration and the first effects time to run before reading the console.
    await page.waitForTimeout(1000);
  }
  expect(problems.filter((p) => HYDRATION.test(p))).toEqual([]);
});

// The server renders in its own time zone and locale; the browser may differ. Any formatted
// date or time that is part of server-rendered markup must not make hydration fail.
test.describe('time zone and locale differ from the server', () => {
  test.use({ timezoneId: 'Pacific/Auckland', locale: 'de-DE' });

  test('clip page, stats and notifications hydrate cleanly', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));

    await signUp(page, uniqueAccount('hydz'));
    const id = await uploadClip(page, 'Zone clip');
    await publishToEveryone(page, id);

    for (const path of [`/content/${id}`, '/notifications', '/']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
    }
    expect(problems.filter((p) => HYDRATION.test(p))).toEqual([]);
  });
});
