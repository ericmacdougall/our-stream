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

  // Reactions, the comments drawer (with a posted comment and the remove dialog) and share dialog.
  await feedItem(page, id).getByTestId('comments-button').click();
  const panel = page.getByTestId('comments-panel');
  await panel.getByLabel('Write a comment').fill('An accessible comment');
  await panel.getByTestId('post-comment').click();
  await expect(panel.getByTestId('comment')).toHaveCount(1);
  await expectNoSeriousViolations(page, 'feed-comments');
  await panel.getByTestId('remove-button').click();
  await expect(page.getByRole('dialog', { name: 'Remove this comment?' })).toBeVisible();
  await expectNoSeriousViolations(page, 'remove-dialog');
  await page.keyboard.press('Escape');
  await feedItem(page, id).getByTestId('share-button').click();
  await expect(page.getByTestId('share-dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'share-dialog');
  await page.keyboard.press('Escape');

  // Content page with its player, then search results with marks and the inline player.
  await page.goto(`/content/${id}?t=200`);
  await expect(page.getByTestId('content-player')).toBeVisible();
  await expectNoSeriousViolations(page, 'content');
  await page.goto('/search?q=accessible');
  await expect(page.getByTestId('search-hit')).toHaveCount(1);
  await expect(page.locator('mark').first()).toBeVisible();
  await expectNoSeriousViolations(page, 'search');
  await page.getByTestId('play-hit').click();
  await expect(page.getByTestId('inline-player')).toBeVisible();
  await expectNoSeriousViolations(page, 'search-player');
  await page.goto('/notifications');
  await expectNoSeriousViolations(page, 'notifications');

  // Account page (digest preference; the set-password form is hidden for a password account).
  await page.goto('/account');
  await expect(page.getByTestId('preferences')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('account.png'), fullPage: true });
  await expectNoSeriousViolations(page, 'account');
  // Organisation settings (the owner) and a stream page with the comments switch.
  await page.goto('/org/settings');
  await expect(page.getByTestId('org-save')).toBeVisible();
  await expectNoSeriousViolations(page, 'org-settings');
});
