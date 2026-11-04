// SPDX-License-Identifier: AGPL-3.0-only
// Likes (M1b): optimistic, one request in flight, queued intent, identical retry after a lost
// response, and the stale-UI path when the clip is retracted behind the viewer's back.
import { expect, test, type Page } from '@playwright/test';
import { apiCall, feedItem, publishToEveryone, signUp, uniqueAccount, uploadClip } from './helpers';

function trackLikes(page: Page): string[] {
  const methods: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/v1\/content\/[^/]+\/like$/.test(r.url()) && r.method() !== 'GET') {
      methods.push(r.method());
    }
  });
  return methods;
}

test('like is optimistic, sends one request per settled intent and retries a lost response', async ({
  page,
}) => {
  const account = uniqueAccount('like');
  await signUp(page, account);
  const id = await uploadClip(page, 'Likeable clip');
  await publishToEveryone(page, id);
  await page.goto('/');
  const item = feedItem(page, id);
  await expect(item).toBeVisible();
  const requests = trackLikes(page);
  const like = () => feedItem(page, id).getByTestId('like-button');
  const count = () => feedItem(page, id).getByTestId('like-count');
  await expect(like()).toHaveAttribute('aria-pressed', 'false');
  await expect(count()).toHaveText('0');

  // Double click: the first click sends POST, the second only flips the intent, which is sent as
  // DELETE once the POST settles. Exactly two requests, final state unliked, server-truthful.
  await like().dblclick();
  await expect.poll(() => requests.length, { timeout: 10_000 }).toBe(2);
  expect(requests).toEqual(['POST', 'DELETE']);
  await expect(like()).toHaveAttribute('aria-pressed', 'false');
  await expect(count()).toHaveText('0');

  // Single click: liked, count 1, persists across a reload.
  await like().click();
  await expect(like()).toHaveAttribute('aria-pressed', 'true');
  await expect(count()).toHaveText('1');
  await expect.poll(() => requests.length).toBe(3);
  await page.reload();
  await expect(like()).toHaveAttribute('aria-pressed', 'true');
  await expect(count()).toHaveText('1');

  // Lost response: the first DELETE is aborted before any answer; the identical request is retried
  // and the end state is unliked on the server too.
  const after = trackLikes(page);
  await page.route('**/api/v1/content/*/like', (route) => route.abort('connectionfailed'), {
    times: 1,
  });
  await like().click();
  await expect(like()).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => after.length, { timeout: 10_000 }).toBe(2);
  expect(after).toEqual(['DELETE', 'DELETE']);
  await page.reload();
  await expect(like()).toHaveAttribute('aria-pressed', 'false');
  await expect(count()).toHaveText('0');
  await page.screenshot({ path: test.info().outputPath('like-settled.png') });

  // Stale UI: the clip is retracted behind the viewer's back; the next like answers "gone", the
  // item leaves the feed and the change is announced.
  const retract = await apiCall(page, 'POST', `/v1/content/${id}/retract`);
  expect(retract.status).toBe(200);
  await like().click();
  await expect(feedItem(page, id)).toHaveCount(0);
  await expect(
    page.getByText('A clip is no longer available and was removed from the feed.'),
  ).toBeVisible();
});
