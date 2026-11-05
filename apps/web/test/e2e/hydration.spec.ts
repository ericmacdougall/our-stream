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

  // suppressHydrationWarning silences the console but keeps the server's text, so also assert what
  // the user sees: browser zone and locale, never the server's UTC/en text. Failed on a2634b0.
  test('visible dates, schedule hint and datetime-local value use the browser zone', async ({
    page,
  }) => {
    await signUp(page, uniqueAccount('hydv'));
    const id = await uploadClip(page, 'Visible zone clip');

    await page.goto(`/content/${id}/publish`);
    await page.getByLabel('Everyone in the organisation').check();
    await page.getByRole('radio', { name: 'Schedule' }).check();
    await page.locator('#publishAt').fill('2030-01-15T09:30');
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.waitForURL((u) => u.pathname === `/content/${id}`);

    // Reopening the form: the controlled input must hold the same local wall time, not a shifted one.
    await page.goto(`/content/${id}/publish`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#publishAt')).toHaveValue('2030-01-15T09:30');
    await expect(page.locator('#publishAt-hint')).toContainText('Pacific/Auckland');

    await page.goto(`/content/${id}`);
    await page.waitForLoadState('networkidle');
    const expected = await page.evaluate(() =>
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(2030, 0, 15, 9, 30),
      ),
    );
    expect(expected).toMatch(/2030/);
    await expect(page.getByTestId('content-meta')).toContainText(expected);
    await expect(page.getByTestId('content-meta')).not.toContainText(' UTC');
  });
});
