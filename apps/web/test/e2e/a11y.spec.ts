// SPDX-License-Identifier: AGPL-3.0-only
// axe-core on sign-in, upload and the feed: no serious or critical violations (acceptance E).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { feedItem, publishToEveryone, signUp, uniqueAccount, uploadClip } from './helpers';

async function expectNoSeriousViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  test.info().annotations.push({
    type: `axe:${label}`,
    description: `${results.violations.length} violations, ${serious.length} serious/critical`,
  });
  expect(
    serious.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.length} nodes) ${v.nodes[0]?.target.join(' ')}`,
    ),
    label,
  ).toEqual([]);
}

test('sign-in, upload and feed have no serious accessibility violations', async ({ page }) => {
  await page.goto('/sign-in');
  await page.screenshot({ path: test.info().outputPath('sign-in.png') });
  await expectNoSeriousViolations(page, 'sign-in');

  const account = uniqueAccount('axe');
  await signUp(page, account);
  await page.goto('/upload');
  await page.getByRole('button', { name: 'Add chapter' }).click();
  await page.getByRole('button', { name: 'Add link' }).click();
  await page.screenshot({ path: test.info().outputPath('upload.png'), fullPage: true });
  await expectNoSeriousViolations(page, 'upload');

  const id = await uploadClip(page, 'Accessible clip');
  await publishToEveryone(page, id);
  await page.goto('/');
  await expect(feedItem(page, id)).toBeVisible();
  await expectNoSeriousViolations(page, 'feed');

  await page.goto(`/content/${id}`);
  await expectNoSeriousViolations(page, 'content');
  await page.goto('/notifications');
  await expectNoSeriousViolations(page, 'notifications');

  // Account page: the form, then the settled outcome (this owner already has a password).
  await page.goto('/account');
  await page.screenshot({ path: test.info().outputPath('account.png'), fullPage: true });
  await expectNoSeriousViolations(page, 'account');
  // Keyboard order: heading -> new password -> show toggle -> confirm -> submit.
  await page.getByLabel('New password', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Show password')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Confirm new password')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Set password' })).toBeFocused();
  await page.getByLabel('New password', { exact: true }).fill(account.password);
  await page.getByLabel('Confirm new password').fill(account.password);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByTestId('password-outcome')).toHaveAttribute('data-outcome', 'alreadySet');
  await expectNoSeriousViolations(page, 'account-settled');
});
