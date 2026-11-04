// SPDX-License-Identifier: AGPL-3.0-only
// Tags and pins in the publish flow and the content editor, feed filters by stream/tag/pinned,
// and per-clip stats under the org privacy mode (counts only unless the mode is `named`).
import { expect, test } from '@playwright/test';
import {
  apiCall,
  createStream,
  feedItem,
  signInInvitee,
  signUp,
  uniqueAccount,
  uploadClip,
} from './helpers';

const mockUrl = `http://127.0.0.1:${process.env['E2E_MOCK_PORT'] ?? 4100}`;

test('tags and an org-wide pin at publish time, feed filters, stats with privacy mode', async ({
  page,
}) => {
  const owner = uniqueAccount('tags');
  await signUp(page, owner);
  await createStream(page, 'Training team', 'training-team');
  const trained = await uploadClip(page, 'Onboarding basics');
  const plain = await uploadClip(page, 'Plain clip');

  // Publish with tags and the org-wide pin (the owner may pin org-wide).
  await page.goto(`/content/${trained}/publish`);
  await page.getByLabel('Everyone in the organisation').check();
  await page.getByLabel('Training team').check();
  await page.getByLabel('Training', { exact: true }).check();
  await page.getByLabel('Onboarding', { exact: true }).check();
  await page.getByLabel('Pin organisation-wide after publishing').check();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await page.goto(`/content/${plain}/publish`);
  await page.getByLabel('Everyone in the organisation').check();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/');

  // Feed: chips and the pinned badge on the tagged clip only.
  await page.goto('/');
  const tagged = feedItem(page, trained);
  await expect(tagged.getByTestId('tag-chip')).toHaveText(['Training', 'Onboarding']);
  await expect(tagged.getByTestId('pinned-badge')).toBeVisible();
  await expect(feedItem(page, plain).getByTestId('tag-chip')).toHaveCount(0);
  await expect(feedItem(page, plain).getByTestId('pinned-badge')).toHaveCount(0);

  // Filters narrow the feed and live in the URL.
  await page.getByLabel('Tag').selectOption('training');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL((u) => u.searchParams.get('tag') === 'training');
  await expect(feedItem(page, trained)).toBeVisible();
  await expect(feedItem(page, plain)).toHaveCount(0);
  await page.goto('/?pinned=true');
  await expect(feedItem(page, trained)).toBeVisible();
  await expect(feedItem(page, plain)).toHaveCount(0);
  await page.goto('/?tag=bogus');
  await expect(feedItem(page, plain)).toBeVisible(); // invalid tag ignored, nothing hidden
  await page.screenshot({ path: test.info().outputPath('feed-filters.png') });

  // Content editor: unpin org-wide, pin to the stream, change tags.
  await page.goto(`/content/${trained}`);
  const editor = page.getByTestId('tags-pins');
  await expect(editor.getByTestId('pinned-badge')).toBeVisible();
  await editor
    .locator('[data-testid="pin-target"][data-stream="org"]')
    .getByTestId('unpin')
    .click();
  await expect(editor.getByText('Unpinned.')).toBeVisible();
  await expect(editor.getByTestId('pinned-badge')).toHaveCount(0);
  const streamTarget = editor.locator('[data-testid="pin-target"]:not([data-stream="org"])');
  await expect(streamTarget).toHaveCount(1);
  await streamTarget.getByTestId('pin').click();
  await expect(editor.getByText('Pinned.')).toBeVisible();
  await expect(editor.getByTestId('pinned-badge')).toBeVisible();
  await editor.getByLabel('Onboarding', { exact: true }).uncheck();
  await editor.getByTestId('save-tags').dblclick();
  await expect(editor.getByText('Tags saved.')).toBeVisible();
  await page.goto('/');
  await expect(feedItem(page, trained).getByTestId('tag-chip')).toHaveText(['Training']);

  // Stats: a view registers; counts only under the default mode, names under `named`.
  await expect(feedItem(page, trained)).toHaveAttribute('data-active', 'true');
  await expect
    .poll(
      () =>
        feedItem(page, trained)
          .getByTestId('feed-video')
          .evaluate((v: HTMLVideoElement) => v.ended),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.goto(`/content/${trained}`);
  const stats = page.getByTestId('stats-panel');
  await expect(stats.getByTestId('stats-privacy')).toHaveAttribute(
    'data-mode',
    /aggregate_only|identified_for_required_only/,
  );
  await expect(stats.getByTestId('stat-unique')).toHaveText('1');
  await expect(stats.getByTestId('stat-completions')).toHaveText('1');
  await expect(stats.getByTestId('viewers-table')).toHaveCount(0);
  await expect(stats.getByText(owner.displayName)).toHaveCount(0);
  const named = await apiCall(page, 'PATCH', '/v1/org/settings', { privacyMode: 'named' });
  expect(named.status).toBe(200);
  await stats.getByRole('button', { name: 'Refresh' }).click();
  await expect(stats.getByTestId('viewers-table')).toBeVisible();
  await expect(
    stats.getByTestId('viewers-table').getByRole('rowheader', { name: owner.displayName }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('stats-named.png'), fullPage: true });
});

test('a plain member sees neither the editor nor the stats, and has no pin targets (mock)', async ({
  page,
  context,
}) => {
  test.skip(Boolean(process.env['E2E_API_URL']), 'needs the mock invitee hook');
  const owner = uniqueAccount('tagsm');
  await signUp(page, owner);
  const id = await uploadClip(page, 'Member view clip');
  await page.goto(`/content/${id}/publish`);
  await page.getByLabel('Everyone in the organisation').check();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await context.clearCookies();
  await signInInvitee(page, mockUrl, owner.orgSlug, `member-${owner.orgSlug}@example.test`);
  await page.goto(`/content/${id}`);
  await expect(page.getByTestId('content-player')).toBeVisible();
  await expect(page.getByTestId('tags-pins')).toHaveCount(0);
  await expect(page.getByTestId('stats-panel')).toHaveCount(0);
  // The API refuses too: a member's org-wide pin is pin_forbidden, stats are author-only.
  const pinned = await apiCall(page, 'POST', `/v1/content/${id}/pin`, { streamId: null });
  expect(pinned.status).toBe(403);
  const stats = await page.request.get(`/api/v1/content/${id}/stats`);
  expect(stats.status()).toBe(403);
});
