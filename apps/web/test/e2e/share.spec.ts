// SPDX-License-Identifier: AGPL-3.0-only
// Share as a link (M1b, ADR-0002): the dialog sends an in-app notification and offers only the
// internal link on this origin. Needs a second member, so the delivered path runs on the mock.
import { expect, test } from '@playwright/test';
import { feedItem, publishToEveryone, signUp, uniqueAccount, uploadClip } from './helpers';

const mockUrl = `http://127.0.0.1:${process.env['E2E_MOCK_PORT'] ?? 4100}`;

test('share sends to a colleague and copies the internal link only', async ({ page, context }) => {
  test.skip(
    Boolean(process.env['E2E_API_URL']),
    'needs the mock invitee hook to create a second member',
  );
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const owner = uniqueAccount('share');
  await signUp(page, owner);
  const id = await uploadClip(page, 'Shareable clip');
  await publishToEveryone(page, id);
  const member = await page.request.post(`${mockUrl}/__mock/invitee`, {
    data: {
      orgSlug: owner.orgSlug,
      email: `colleague-${owner.orgSlug}@example.test`,
      displayName: 'Colleague',
    },
  });
  expect(member.ok()).toBe(true);

  await page.goto('/');
  await feedItem(page, id).getByTestId('share-button').click();
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog).toBeVisible();
  const recipient = dialog.getByLabel('Send to');
  await expect(recipient).toContainText('Colleague');
  // The sharer is never offered as a recipient.
  await expect(recipient.locator('option', { hasText: owner.displayName })).toHaveCount(0);
  await recipient.selectOption({ label: 'Colleague' });
  await dialog.getByTestId('share-send').dblclick();
  const outcome = dialog.getByTestId('share-outcome');
  await expect(outcome).toHaveAttribute('data-delivered', 'true');
  await expect(outcome).toHaveText('Sent to Colleague.');
  const link = dialog.getByTestId('share-link');
  await expect(link).toHaveValue(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/content/${id}$`));
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  await expect(dialog.getByText('Link copied.')).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(await link.inputValue());
  await page.screenshot({ path: test.info().outputPath('share-dialog.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
