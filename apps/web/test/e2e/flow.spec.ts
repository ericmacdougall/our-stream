// SPDX-License-Identifier: AGPL-3.0-only
// Acceptance E (roadmap): sign-up -> stream -> upload -> publish -> feed plays -> retract -> gone.
import { expect, test } from '@playwright/test';
import { createStream, feedItem, signUp, uniqueAccount, uploadClip } from './helpers';

test('publish a clip, watch it in the feed, retract it everywhere', async ({ page }) => {
  const account = uniqueAccount('flow');
  await signUp(page, account);

  await createStream(page, 'Onboarding', 'onboarding');

  const contentId = await uploadClip(page, 'Welcome clip', { chapter: true });

  // Idempotent publish: a double-click must send exactly one publish request.
  const publishRequests: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/content/${contentId}/publish`)) {
      publishRequests.push(r.url());
    }
  });
  await page.goto(`/content/${contentId}/publish`);
  await page.getByLabel('Everyone in the organisation').check();
  await page.getByRole('button', { name: 'Publish', exact: true }).dblclick();
  await page.waitForURL((u) => u.pathname === '/');
  expect(publishRequests).toHaveLength(1);

  // The feed shows the item and plays it.
  const item = feedItem(page, contentId);
  await expect(item).toBeVisible();
  await expect(item.getByRole('heading', { name: 'Welcome clip' })).toBeVisible();
  // The feed shows the chapter time in the same form the upload form settled on.
  await expect(item.getByRole('button', { name: '0:02 Second chapter' })).toBeVisible();
  const video = item.getByTestId('feed-video');
  const codecs = await video.evaluate((v: HTMLVideoElement) => ({
    h264: v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
    hls: v.canPlayType('application/vnd.apple.mpegurl'),
    src: v.currentSrc || v.src,
  }));
  test.info().annotations.push({ type: 'codecs', description: JSON.stringify(codecs) });
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(3);
  const t0 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThan(t0);
  await expect(video).toHaveJSProperty('muted', true);
  await page.screenshot({ path: test.info().outputPath('feed-playing.png') });

  // View recorded: the item is marked viewed after a reload.
  await page.reload();
  await expect(feedItem(page, contentId).getByTestId('viewed-badge')).toBeVisible();

  // Retract: Escape keeps it, confirming removes it.
  await page.goto(`/content/${contentId}`);
  await expect(page.getByTestId('content-state')).toHaveText('Published');
  await expect(page.getByText('0:02 Second chapter')).toBeVisible();
  await page.getByRole('button', { name: 'Retract', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Retract this clip?' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('content-state')).toHaveText('Published');
  await page.getByRole('button', { name: 'Retract', exact: true }).click();
  await dialog.getByRole('button', { name: 'Retract everywhere' }).click();
  await expect(page.getByTestId('content-state')).toHaveText('Retracted');
  await page.screenshot({ path: test.info().outputPath('content-retracted.png') });

  await page.goto('/');
  await expect(page.getByTestId('feed')).toBeVisible();
  await expect(feedItem(page, contentId)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Nothing here yet' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('feed-after-retract.png') });

  // Media for the retracted version fails closed.
  const mediaStatus = await page.evaluate(async (id) => {
    const r = await fetch(`/media/${id}/x/hls/master.m3u8`, { credentials: 'include' });
    return r.status;
  }, contentId);
  expect(mediaStatus).toBeGreaterThanOrEqual(400);
});

test('sign-in rejects a wrong password and magic-link copy stays neutral', async ({ page }) => {
  const account = uniqueAccount('auth');
  await signUp(page, account);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((u) => u.pathname === '/sign-in');

  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Next's route announcer is also role=alert; target the form notice.
  await expect(page.locator('.notice-error')).toContainText('did not match');

  await page.getByLabel('Email').fill('nobody@example.test');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.locator('.notice-success')).toContainText(
    'If that address belongs to an account',
  );

  // Signed-out visitors are bounced from protected pages by the optimistic proxy check.
  await page.goto('/upload');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fupload/);
});
