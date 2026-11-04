// SPDX-License-Identifier: AGPL-3.0-only
// Engagement reporting (M1b, ADR-0006): one view_start, each milestone once and one complete per
// playback session; a seek while paused fires nothing and milestones it skipped never fire; a
// replay after complete uses a new session key; /content/{id}?t= opens the player at that instant
// and the share-link target plays for a plain member.
import { expect, test, type Page } from '@playwright/test';
import {
  feedItem,
  publishToEveryone,
  signInInvitee,
  signUp,
  uniqueAccount,
  uploadClip,
} from './helpers';

const mockUrl = `http://127.0.0.1:${process.env['E2E_MOCK_PORT'] ?? 4100}`;

interface Sent {
  type: string;
  sessionKey: string;
  versionId: string;
  positionMs: number;
}

function trackEngagement(page: Page): Sent[] {
  const sent: Sent[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/v1\/content\/[^/]+\/engagement$/.test(r.url())) {
      const body = r.postDataJSON() as Sent;
      sent.push(body);
    }
  });
  return sent;
}

const types = (sent: Sent[]) => sent.map((s) => s.type);

test('a full playback reports each milestone once; seeks fire nothing; replay is a new session', async ({
  page,
}) => {
  const account = uniqueAccount('eng');
  await signUp(page, account);
  const id = await uploadClip(page, 'Measured clip');
  await publishToEveryone(page, id);
  await page.goto('/');
  const item = feedItem(page, id);
  await expect(item).toBeVisible();
  const video = item.getByTestId('feed-video');
  const sent = trackEngagement(page);

  // Muted autoplay runs the 1 s fixture to the end: exactly one event per type, one session key.
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.ended), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => types(sent).filter((t) => t === 'complete').length, { timeout: 10_000 })
    .toBe(1);
  const first = [...sent];
  expect(types(first).sort()).toEqual(
    ['complete', 'progress_25', 'progress_50', 'progress_75', 'view_start'].sort(),
  );
  const key = first[0]?.sessionKey;
  expect(key).toBeTruthy();
  for (const e of first) expect(e.sessionKey).toBe(key);

  // Replay after complete: a new session key; a seek while paused sends nothing; the thresholds
  // skipped by the seek never fire, only what playback crosses afterwards.
  const before = sent.length;
  // After "ended" the feed still considers the item playing; the first toggle pauses, the second
  // restarts the clip from the beginning.
  await page.getByTestId('toggle-play').click();
  await expect(page.getByTestId('toggle-play')).toHaveText('Play');
  await page.getByTestId('toggle-play').click();
  await expect
    .poll(() => types(sent.slice(before)).filter((t) => t === 'view_start').length, {
      timeout: 10_000,
    })
    .toBe(1);
  const second = sent.slice(before);
  expect(second[0]?.sessionKey).not.toBe(key);

  // Pause, seek to 90 %, wait: no milestone from the seek.
  await page.getByTestId('toggle-play').click(); // pause
  await expect(video).toHaveJSProperty('paused', true);
  const dur = await video.evaluate((v: HTMLVideoElement) => v.duration);
  const countBeforeSeek = sent.length;
  await video.evaluate((v: HTMLVideoElement, d: number) => {
    v.currentTime = d * 0.9;
  }, dur);
  await page.waitForTimeout(700);
  expect(sent.length).toBe(countBeforeSeek);
  // Resume: only complete can still fire for this session (75 % was jumped over).
  await page.getByTestId('toggle-play').click();
  await expect
    .poll(() => types(sent.slice(countBeforeSeek)), { timeout: 15_000 })
    .toEqual(['complete']);
  await page.screenshot({ path: test.info().outputPath('engagement-feed.png') });
});

test('/content/{id}?t= opens the player at that instant and reports engagement', async ({
  page,
}) => {
  const account = uniqueAccount('engt');
  await signUp(page, account);
  const id = await uploadClip(page, 'Deep-linked clip');
  await publishToEveryone(page, id);
  await page.goto(`/content/${id}?t=500`);
  const player = page.getByTestId('content-player');
  await expect(player).toBeVisible();
  await expect(page.getByTestId('content-start-at')).toContainText('from 0:00');
  const video = player.getByTestId('feed-video');
  await expect(video).toHaveJSProperty('paused', true);
  const sent = trackEngagement(page);
  await page.getByTestId('content-play').click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(0.5);
  await expect
    .poll(() => types(sent).filter((t) => t === 'view_start').length, { timeout: 10_000 })
    .toBe(1);
  // Reactions and comments are available on the content page too.
  await expect(player.locator('..').getByTestId('like-button')).toBeVisible();
  await page.getByTestId('comments-button').click();
  await expect(page.getByTestId('comments-panel')).toBeVisible();
});

test('a share-link recipient who is a plain member can play the clip (mock)', async ({
  page,
  context,
}) => {
  test.skip(Boolean(process.env['E2E_API_URL']), 'needs the mock invitee hook');
  const owner = uniqueAccount('engs');
  await signUp(page, owner);
  const id = await uploadClip(page, 'Shared clip');
  await publishToEveryone(page, id);
  await context.clearCookies();
  await signInInvitee(page, mockUrl, owner.orgSlug, `viewer-${owner.orgSlug}@example.test`);
  await page.goto(`/content/${id}`);
  await expect(page.getByTestId('content-player')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retract', exact: true })).toHaveCount(0);
  await page.getByTestId('content-play').click();
  await expect
    .poll(
      () =>
        page
          .getByTestId('content-player')
          .getByTestId('feed-video')
          .evaluate((v: HTMLVideoElement) => v.currentTime),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
});
