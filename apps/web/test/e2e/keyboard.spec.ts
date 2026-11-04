// SPDX-License-Identifier: AGPL-3.0-only
// Keyboard navigation and the WCAG 2.1.4 shortcut switch on the feed.
import { expect, test } from '@playwright/test';
import { feedItem, publishToEveryone, signUp, uniqueAccount, uploadClip } from './helpers';

test('arrows, J/K, Space, C and M drive the feed; shortcuts can be disabled', async ({ page }) => {
  const account = uniqueAccount('keys');
  await signUp(page, account);
  const first = await uploadClip(page, 'First clip');
  await publishToEveryone(page, first);
  const second = await uploadClip(page, 'Second clip');
  await publishToEveryone(page, second);

  await page.goto('/');
  // Newest first.
  const items = page.getByTestId('feed-item');
  await expect(items).toHaveCount(2);
  await expect(feedItem(page, second)).toHaveAttribute('data-active', 'true');
  await expect(feedItem(page, first)).toHaveAttribute('data-active', 'false');

  await page.getByTestId('feed').focus();
  await page.keyboard.press('ArrowDown');
  await expect(feedItem(page, first)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('k');
  await expect(feedItem(page, second)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('j');
  await expect(feedItem(page, first)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(feedItem(page, second)).toHaveAttribute('data-active', 'true');

  // Space pauses; the persistent control reflects it.
  const playToggle = page.getByTestId('toggle-play');
  await expect(playToggle).toHaveText('Pause');
  await page.keyboard.press('Space');
  await expect(playToggle).toHaveText('Play');
  await expect(feedItem(page, second).getByTestId('feed-video')).toHaveJSProperty('paused', true);
  await page.keyboard.press('Space');
  await expect(playToggle).toHaveText('Pause');

  // C toggles captions, M toggles mute.
  const captions = page.getByTestId('toggle-captions');
  await expect(captions).toHaveText('Captions off');
  await page.keyboard.press('c');
  await expect(captions).toHaveText('Captions on');
  await expect(feedItem(page, second).getByTestId('feed-video')).toHaveJSProperty(
    'textTracks.0.mode',
    'hidden',
  );
  await page.keyboard.press('c');
  await expect(captions).toHaveText('Captions off');
  await expect(feedItem(page, second).getByTestId('feed-video')).toHaveJSProperty(
    'textTracks.0.mode',
    'showing',
  );
  const mute = page.getByTestId('toggle-mute');
  await expect(mute).toHaveText('Unmute');
  await page.keyboard.press('m');
  await expect(mute).toHaveText('Mute');
  await expect(feedItem(page, second).getByTestId('feed-video')).toHaveJSProperty('muted', false);
  await page.keyboard.press('m');
  await expect(mute).toHaveText('Unmute');

  // Disable single-key shortcuts: J no longer moves, arrows still do (WCAG 2.1.4).
  await page.locator('summary', { hasText: 'Settings' }).click();
  await page.getByTestId('setting-shortcuts').uncheck();
  await page.getByTestId('feed').focus();
  await page.keyboard.press('j');
  await expect(feedItem(page, second)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(feedItem(page, first)).toHaveAttribute('data-active', 'true');
  // The preference survives a reload.
  await page.reload();
  await page.locator('summary', { hasText: 'Settings' }).click();
  await expect(page.getByTestId('setting-shortcuts')).not.toBeChecked();
});

test('reduced motion disables autoplay until the viewer presses play', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const account = uniqueAccount('motion');
  await signUp(page, account);
  const id = await uploadClip(page, 'Calm clip');
  await publishToEveryone(page, id);
  await page.goto('/');
  const item = feedItem(page, id);
  await expect(item).toHaveAttribute('data-active', 'true');
  await expect(item.getByRole('button', { name: /Play/ })).toBeVisible();
  await expect(item.getByTestId('feed-video')).toHaveJSProperty('paused', true);
  await item.getByRole('button', { name: /Play/ }).click();
  await expect(item.getByTestId('feed-video')).toHaveJSProperty('paused', false);
  await context.close();
});
