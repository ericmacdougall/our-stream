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
});
