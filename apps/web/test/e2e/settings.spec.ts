// SPDX-License-Identifier: AGPL-3.0-only
// Notification preference, organisation settings (owners/admins) and the per-stream comments switch.
import { expect, test } from '@playwright/test';
import {
  createStream,
  feedItem,
  signInInvitee,
  signUp,
  uniqueAccount,
  uploadClip,
} from './helpers';

const mockUrl = `http://127.0.0.1:${process.env['E2E_MOCK_PORT'] ?? 4100}`;

test('digest preference persists; org settings save; a stream switch turns comments off', async ({
  page,
}) => {
  const owner = uniqueAccount('settings');
  await signUp(page, owner);

  // Preference: daily by default, off after the change, still off after a reload.
  await page.goto('/account');
  const prefs = page.getByTestId('preferences');
  await expect(prefs.getByLabel('Daily')).toBeChecked();
  await prefs.getByLabel('Off').check();
  await expect(prefs.getByText('Preference saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('preferences').getByLabel('Off')).toBeChecked();

  // Org settings: the owner has the nav link, changes privacy mode and the scanner, saves once.
  await page.getByRole('link', { name: 'Organisation' }).click();
  await page.waitForURL((u) => u.pathname === '/org/settings');
  await page.getByLabel('Viewing privacy').selectOption('named');
  await page.getByLabel('Comment scanner').selectOption('warn');
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/v1/org/settings')) patches.push(r.url());
  });
  await page.getByTestId('org-save').dblclick();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  expect(patches).toHaveLength(1);
  await page.reload();
  await expect(page.getByLabel('Viewing privacy')).toHaveValue('named');
  await expect(page.getByLabel('Comment scanner')).toHaveValue('warn');
  await page.screenshot({ path: test.info().outputPath('org-settings.png'), fullPage: true });

  // Stream comments switch: publishing to that stream only, the feed shows the disabled notice.
  await createStream(page, 'Quiet room', 'quiet-room');
  const id = await uploadClip(page, 'Quiet clip');
  await page.goto(`/content/${id}/publish`);
  await page.getByLabel('Quiet room').check();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await page.goto('/streams');
  await page.getByTestId('streams-list').getByRole('link', { name: 'Quiet room' }).click();
  const toggle = page.getByTestId('stream-comments-toggle');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.getByText('Comment setting saved.')).toBeVisible();
  await expect(page.getByText('Turned off')).toBeVisible();
  await page.goto('/');
  await feedItem(page, id).getByTestId('comments-button').click();
  await expect(page.getByTestId('comments-disabled')).toBeVisible();
  await expect(page.getByTestId('comments-panel').getByLabel('Write a comment')).toHaveCount(0);
});

test('a member cannot change organisation settings (mock)', async ({ page, context }) => {
  test.skip(Boolean(process.env['E2E_API_URL']), 'needs the mock invitee hook');
  const owner = uniqueAccount('settm');
  await signUp(page, owner);
  await context.clearCookies();
  await signInInvitee(page, mockUrl, owner.orgSlug, `member-${owner.orgSlug}@example.test`);
  await expect(page.getByRole('link', { name: 'Organisation' })).toHaveCount(0);
  await page.goto('/org/settings');
  await expect(
    page.getByText('Only organisation owners and admins can change these settings.'),
  ).toBeVisible();
  await expect(page.getByTestId('org-save')).toHaveCount(0);
  // The invitee still sees the one-time set-password form (no password yet).
  await page.goto('/account');
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
});
