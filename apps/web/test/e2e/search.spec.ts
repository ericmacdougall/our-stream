// SPDX-License-Identifier: AGPL-3.0-only
// Keyword search (M1b, ADR-0013): the nav box lands on /search?q=, results show a count and
// highlighted snippets, a transcript hit opens an inline player at its timestamp and the URL
// becomes a shareable deep link; malformed URL filters never reach the API.
import { expect, test, type Page } from '@playwright/test';
import { publishToEveryone, signUp, uniqueAccount, uploadClip } from './helpers';

function trackSearches(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && /\/api\/v1\/search\?/.test(r.url())) urls.push(r.url());
  });
  return urls;
}

test('nav search, counts, snippets, timestamp deep link and URL hygiene', async ({ page }) => {
  const account = uniqueAccount('search');
  await signUp(page, account);
  const id = await uploadClip(page, 'Budget review', {
    description: 'Budget review for the third quarter. The hiring freeze stays in place.',
  });
  await publishToEveryone(page, id);
  await uploadClip(page, 'Unrelated clip', { description: 'Nothing about money here.' });

  // Nav search box: a plain GET form.
  await page.goto('/');
  const searches = trackSearches(page);
  await page.getByRole('searchbox', { name: 'Search' }).fill('hiring');
  await page.getByRole('searchbox', { name: 'Search' }).press('Enter');
  await page.waitForURL((u) => u.pathname === '/search' && u.searchParams.get('q') === 'hiring');
  await expect(page.getByTestId('search-total')).toHaveText('1 result');
  const hit = page.getByTestId('search-hit').filter({ hasText: 'Budget review' });
  await expect(hit).toHaveCount(1);
  // Highlighted snippet from the description; the mock also yields a transcript window with a
  // timestamp (the real fixture has no speech, so there the plain Play opens the hit at 0:00).
  await expect(hit.locator('mark').first()).toHaveText(/hiring/i);
  await expect.poll(() => searches.length).toBeGreaterThanOrEqual(1);
  expect(searches[0]).toContain('q=hiring');
  const playFrom = hit.getByTestId('play-from').filter({ hasText: 'Play from 0:02' });
  const hasTranscript = (await playFrom.count()) > 0;
  const expectedMs = hasTranscript ? 2000 : 0;
  test.info().annotations.push({ type: 'transcript-hit', description: String(hasTranscript) });
  await page.screenshot({ path: test.info().outputPath('search-results.png'), fullPage: true });

  // Timestamp deep link: the inline player opens seeked to t and the URL carries play+t.
  if (hasTranscript) await playFrom.click();
  else await hit.getByTestId('play-hit').click();
  const player = page.getByTestId('inline-player');
  await expect(player).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`play=${id}`));
  await expect(page).toHaveURL(new RegExp(`t=${expectedMs}(&|$)`));
  const video = player.getByTestId('feed-video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(expectedMs / 1000 - 0.1);
  await expect(
    page.getByText(new RegExp(`Playing "Budget review" from ${hasTranscript ? '0:02' : '0:00'}`)),
  ).toBeAttached();

  // The deep link reopens the same hit after a fresh load.
  const deepLink = page.url();
  await page.goto(deepLink);
  await expect(page.getByTestId('inline-player')).toBeVisible();
  await page.getByRole('button', { name: 'Close player' }).click();
  await expect(page.getByTestId('inline-player')).toHaveCount(0);
  await expect(page).not.toHaveURL(/play=/);

  // A deep link to a clip that is not in the results degrades to a notice with a direct link.
  await page.goto(`/search?q=hiring&play=00000000-0000-4000-8000-000000000000&t=5`);
  await expect(page.getByText('The clip from this link is not among these results.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open clip' })).toHaveAttribute(
    'href',
    '/content/00000000-0000-4000-8000-000000000000?t=5',
  );

  // Malformed filters are dropped before any request; an empty query sends nothing.
  const before = searches.length;
  await page.goto('/search?q=hiring&tag=bogus&streamId=not-a-uuid');
  await expect(page.getByTestId('search-total')).toHaveText('1 result');
  await expect.poll(() => searches.length).toBe(before + 1);
  expect(searches[searches.length - 1]).not.toContain('tag=');
  expect(searches[searches.length - 1]).not.toContain('streamId=');
  const beforeEmpty = searches.length;
  await page.goto('/search');
  await expect(page.getByText(/Type what you remember/)).toBeVisible();
  await page.waitForTimeout(500);
  expect(searches.length).toBe(beforeEmpty);

  // Exclusion syntax and the empty state.
  await page.goto('/search?q=budget%20-hiring');
  await expect(page.getByTestId('search-total')).toHaveText('No results');
  await expect(page.getByText('Nothing matched. Try other words.')).toBeVisible();
});
