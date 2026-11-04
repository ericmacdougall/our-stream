// SPDX-License-Identifier: AGPL-3.0-only
// Threaded comments (M1b, Q7): post and reply with one request per double-click, drafts that keep
// their clientKey across a reload, identical retry after a lost response, report, remove behind a
// confirm dialog (Escape keeps), a disabled stream, and the stale-UI path after a retraction.
import { expect, test, type Page } from '@playwright/test';
import {
  apiCall,
  createStream,
  feedItem,
  publishToEveryone,
  signInInvitee,
  signUp,
  uniqueAccount,
  uploadClip,
} from './helpers';

const mockUrl = `http://127.0.0.1:${process.env['E2E_MOCK_PORT'] ?? 4100}`;

function trackCommentPosts(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/v1\/content\/[^/]+\/comments$/.test(r.url())) {
      urls.push(r.url());
    }
  });
  return urls;
}

async function openComments(page: Page, id: string) {
  await feedItem(page, id).getByTestId('comments-button').click();
  const panel = page.getByTestId('comments-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('post, reply, draft persistence, lost response, report, remove with Escape then confirm', async ({
  page,
}) => {
  const account = uniqueAccount('cmt');
  await signUp(page, account);
  const id = await uploadClip(page, 'Discussed clip');
  await publishToEveryone(page, id);
  await page.goto('/');
  let panel = await openComments(page, id);
  await expect(panel.getByText('No comments yet.')).toBeVisible();

  // An unsent draft survives a reload together with its key.
  await panel.getByLabel('Write a comment').fill('First thoughts');
  await page.reload();
  panel = await openComments(page, id);
  await expect(panel.getByLabel('Write a comment')).toHaveValue('First thoughts');

  // Double-click posts once.
  const posts = trackCommentPosts(page);
  await panel.getByTestId('post-comment').dblclick();
  const first = panel.getByTestId('comment').filter({ hasText: 'First thoughts' });
  await expect(first).toBeVisible();
  await expect.poll(() => posts.length).toBe(1);
  await expect(feedItem(page, id).getByTestId('comment-count')).toHaveText('1');
  await expect(panel.getByLabel('Write a comment')).toHaveValue('');

  // Reply attaches under the root.
  await first.getByRole('button', { name: 'Reply' }).click();
  const replyBox = panel.getByLabel('Write a reply');
  await expect(replyBox).toBeFocused();
  await replyBox.fill('A reply');
  await panel.getByTestId('post-reply').click();
  const reply = panel.getByTestId('comment').filter({ hasText: 'A reply' });
  await expect(reply).toBeVisible();
  await expect(feedItem(page, id).getByTestId('comment-count')).toHaveText('2');

  // Lost response: the first POST is aborted; the identical payload (same clientKey) is retried and
  // exactly one comment appears.
  await page.route('**/api/v1/content/*/comments', (route) => route.abort('connectionfailed'), {
    times: 1,
  });
  await panel.getByLabel('Write a comment').fill('Second thoughts');
  const before = posts.length;
  await panel.getByTestId('post-comment').click();
  await expect(panel.getByTestId('comment').filter({ hasText: 'Second thoughts' })).toHaveCount(1);
  await expect.poll(() => posts.length).toBe(before + 2);
  await expect(feedItem(page, id).getByTestId('comment-count')).toHaveText('3');

  // Report once; the button settles to "Reported".
  await reply.getByTestId('report-button').click();
  await expect(reply.getByTestId('report-button')).toHaveText('Reported');
  await expect(reply.getByTestId('report-button')).toBeDisabled();

  // Remove: Escape keeps, confirm removes to a tombstone that receives focus.
  await first.getByTestId('remove-button').click();
  const dialog = page.getByRole('dialog', { name: 'Remove this comment?' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(first).toBeVisible();
  await first.getByTestId('remove-button').click();
  await dialog.getByTestId('remove-confirm').click();
  await expect(dialog).toBeHidden();
  const tomb = panel.locator('[data-testid="comment"][data-state="removed"]');
  await expect(tomb).toHaveCount(1);
  await expect(tomb).toContainText('Comment removed');
  await expect(tomb).toBeFocused();
  // The thread keeps its shape: the reply is still under the removed root.
  await expect(reply).toBeVisible();
  await expect(feedItem(page, id).getByTestId('comment-count')).toHaveText('2');
  await page.screenshot({ path: test.info().outputPath('comments-thread.png') });

  // Feed shortcuts stay off while typing in the drawer: "j" is text, not "next clip".
  await panel.getByLabel('Write a comment').fill('');
  await panel.getByLabel('Write a comment').press('j');
  await expect(panel.getByLabel('Write a comment')).toHaveValue('j');
  await expect(feedItem(page, id)).toHaveAttribute('data-active', 'true');

  // Stale UI: retracted behind the viewer's back; the next post answers "gone".
  const retract = await apiCall(page, 'POST', `/v1/content/${id}/retract`);
  expect(retract.status).toBe(200);
  await panel.getByLabel('Write a comment').fill('too late');
  await panel.getByTestId('post-comment').click();
  await expect(feedItem(page, id)).toHaveCount(0);
  await expect(
    page.getByText('A clip is no longer available and was removed from the feed.'),
  ).toBeVisible();
});

test('a stream with comments turned off shows the notice and no form', async ({ page }) => {
  const account = uniqueAccount('cmtoff');
  await signUp(page, account);
  await createStream(page, 'Quiet team', 'quiet-team');
  const id = await uploadClip(page, 'Quiet clip');
  // Publish to the stream only, then switch its comments off through the API (no UI yet here).
  await page.goto(`/content/${id}/publish`);
  await page.getByLabel('Quiet team').check();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/');
  const streams = await page.request.get('/api/v1/streams');
  // The contract says { items }, the API currently emits a bare array (reported); accept both.
  const raw = (await streams.json()) as unknown;
  const items = (Array.isArray(raw) ? raw : ((raw as { items?: unknown[] }).items ?? [])) as {
    id: string;
    slug: string;
  }[];
  const stream = items.find((s) => s.slug === 'quiet-team');
  expect(stream).toBeTruthy();
  const patched = await apiCall(page, 'PATCH', `/v1/streams/${stream!.id}`, {
    commentsEnabled: false,
  });
  expect(patched.status).toBe(200);
  await page.goto('/');
  const panel = await openComments(page, id);
  await expect(panel.getByTestId('comments-disabled')).toBeVisible();
  await expect(panel.getByLabel('Write a comment')).toHaveCount(0);
});

test('a moderator sees report counts and can remove another member comment (mock)', async ({
  page,
  context,
}) => {
  test.skip(
    Boolean(process.env['E2E_API_URL']),
    'needs the mock invitee hook; the real API needs a mailbox for the invite link',
  );
  const owner = uniqueAccount('mod');
  await signUp(page, owner);
  const id = await uploadClip(page, 'Moderated clip');
  await publishToEveryone(page, id);

  // A member (no moderation rights) comments.
  await context.clearCookies();
  await signInInvitee(page, mockUrl, owner.orgSlug, `member-${owner.orgSlug}@example.test`);
  await page.goto('/');
  let panel = await openComments(page, id);
  await panel.getByLabel('Write a comment').fill('Member says hi');
  await panel.getByTestId('post-comment').click();
  const theirs = panel.getByTestId('comment').filter({ hasText: 'Member says hi' });
  await expect(theirs).toBeVisible();
  // Own comment can be removed, others' cannot: a member sees no report count.
  await expect(theirs.getByTestId('remove-button')).toBeVisible();
  await expect(theirs.getByText(/report/i).filter({ hasText: /\d/ })).toHaveCount(0);
  await theirs.getByTestId('report-button').click();
  await expect(theirs.getByTestId('report-button')).toHaveText('Reported');

  // The org owner moderates: sees "1 report", removes it.
  await context.clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/');
  panel = await openComments(page, id);
  const target = panel.getByTestId('comment').filter({ hasText: 'Member says hi' });
  await expect(target.getByText('1 report')).toBeVisible();
  await target.getByTestId('remove-button').click();
  await page
    .getByRole('dialog', { name: 'Remove this comment?' })
    .getByTestId('remove-confirm')
    .click();
  await expect(panel.locator('[data-testid="comment"][data-state="removed"]')).toHaveCount(1);
});
