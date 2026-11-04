// SPDX-License-Identifier: AGPL-3.0-only
// Signed-in visitors never see the sign-in or sign-up forms (GoodQA work-tracker-automatic#35644):
// the pages check the session server-side and redirect to / or the same-origin ?next target. A stale
// cookie still renders the form, so the proxy, the DAL and the pages cannot loop.
import { expect, test } from '@playwright/test';
import { signUp, uniqueAccount } from './helpers';

test('sign-in and sign-up redirect a signed-in user; /magic stays reachable', async ({ page }) => {
  const account = uniqueAccount('redir');
  await signUp(page, account);

  const cases: [string, string][] = [
    ['/sign-in', '/'],
    ['/sign-in?next=%2Fstreams', '/streams'],
    ['/sign-in?next=//evil.example', '/'],
    ['/sign-in?next=https://evil.example', '/'],
    ['/sign-in?next=%2Fapi%2Fv1%2Fme', '/'],
    ['/sign-in?next=%2Fsign-up', '/'],
    ['/sign-up', '/'],
    ['/sign-up?next=%2Fupload', '/upload'],
  ];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  for (const [from, to] of cases) {
    await page.goto(from);
    await expect(page, from).toHaveURL(new RegExp(`^http://[^/]+${escape(to)}$`));
    await expect(page.getByRole('heading', { name: 'Sign in' }), from).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Create your organisation' }), from).toHaveCount(
      0,
    );
  }
  await page.screenshot({ path: test.info().outputPath('sign-in-while-signed-in.png') });

  // A signed-in user may still consume a link (for example an invite into another organisation).
  await page.goto(`/magic?token=${'x'.repeat(40)}`);
  await expect(page).toHaveURL(/\/magic\?token=/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('a stale session cookie renders the sign-in form instead of looping', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'os_session', value: 'stale-' + 'f'.repeat(40), url: baseURL ?? 'http://127.0.0.1' },
  ]);
  const page = await context.newPage();
  await page.goto('/sign-in?next=%2Fstreams');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fstreams$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // And a protected page with the stale cookie still ends on the form exactly once.
  await page.goto('/streams');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fstreams$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await context.close();
});
