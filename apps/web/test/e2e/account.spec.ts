// SPDX-License-Identifier: AGPL-3.0-only
// F6 (GoodQA work-tracker-automatic#35644): an invitee who signed in by magic link can choose a
// password once from /account; accounts that already have one see the settled 409 outcome.
import { expect, test, type Page } from '@playwright/test';
import { signIn, signUp, uniqueAccount } from './helpers';

const NEW_PASSWORD = 'a long enough phrase for an invitee';
const mockUrl = `http://127.0.0.1:${process.env['E2E_MOCK_PORT'] ?? 4100}`;

async function fillPasswordForm(page: Page, password: string) {
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm new password').fill(password);
}

test('an account that already has a password sees the settled outcome, not a generic error', async ({
  page,
}) => {
  const account = uniqueAccount('pw409');
  await signUp(page, account);

  await page.getByRole('link', { name: `Account: ${account.displayName}` }).click();
  await page.waitForURL((u) => u.pathname === '/account');
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();

  // Client-side checks come first: mismatch never reaches the server.
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/v1/auth/password')) posts.push(r.url());
  });
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(`${NEW_PASSWORD}x`);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText('The two passwords do not match.');
  expect(posts).toHaveLength(0);

  await fillPasswordForm(page, NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  const outcome = page.getByTestId('password-outcome');
  await expect(outcome).toHaveAttribute('data-outcome', 'alreadySet');
  await expect(outcome).toContainText('This account already has a password');
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  await expect(outcome).toBeFocused();
  expect(posts).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath('account-already-set.png') });

  // The old password still works: nothing was changed by the refused request.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((u) => u.pathname === '/sign-in');
  await signIn(page, account);
});

test('an invitee sets a password once: lost response, retry, double-click, then signs in with it', async ({
  page,
  context,
}) => {
  test.skip(
    Boolean(process.env['E2E_API_URL']),
    'needs the mock /__mock/invitee hook; the real API needs a mailbox for the invite link',
  );
  const owner = uniqueAccount('pwown');
  await signUp(page, owner);
  const inviteeEmail = `invitee-${owner.orgSlug}@example.test`;
  const created = await page.request.post(`${mockUrl}/__mock/invitee`, {
    data: { orgSlug: owner.orgSlug, email: inviteeEmail, displayName: 'Invited Person' },
  });
  expect(created.ok()).toBe(true);
  const { token } = (await created.json()) as { token: string };

  // Fresh visitor: consume the invite link (explicit press, as the product requires).
  await context.clearCookies();
  await page.goto(`/magic?token=${token}`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/');

  // A password-less account cannot use the password form yet.
  await context.clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(inviteeEmail);
  await page.getByLabel('Password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('p[role="alert"]')).toHaveText(
    'That email and password did not match.',
  );

  // Back in through a fresh link (the first was single use; re-inviting mints a new one).
  const second = await page.request.post(`${mockUrl}/__mock/invitee`, {
    data: { orgSlug: owner.orgSlug, email: inviteeEmail },
  });
  expect(second.ok()).toBe(true);
  const { token: token2 } = (await second.json()) as { token: string };
  await page.goto(`/magic?token=${token2}`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/');

  await page.goto('/account');
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/v1/auth/password')) posts.push(r.url());
  });

  // Lost response AFTER the server committed: the mock stores the password, then drops the socket,
  // so the browser sees a failed/5xx answer. The typed value must freeze (only an identical retry).
  const drop = await page.request.post(`${mockUrl}/__mock/drop-next-response`);
  expect(drop.ok()).toBe(true);
  await fillPasswordForm(page, NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.locator('p[role="alert"]')).toContainText('The server did not answer');
  await expect(page.getByLabel('New password', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Confirm new password')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Set password' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('account-uncertain.png') });

  // Retry resends the same payload; a double click sends exactly one request. The server already
  // holds this value, so it answers 409, which the form reports as "your earlier attempt did reach
  // the server", never as someone else's password.
  await page.getByRole('button', { name: 'Retry with the same password' }).dblclick();
  const outcome = page.getByTestId('password-outcome');
  await expect(outcome).toHaveAttribute('data-outcome', 'alreadySet');
  await expect(outcome).toHaveAttribute('data-after-retry', 'true');
  await expect(outcome).toContainText('Your earlier attempt did reach the server');
  await expect(outcome).toBeFocused();
  expect(posts).toHaveLength(2); // the dropped one and exactly one retry
  await page.screenshot({ path: test.info().outputPath('account-set.png') });

  // The password now works, and a second attempt is refused as already set.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((u) => u.pathname === '/sign-in');
  await signIn(page, { ...owner, email: inviteeEmail, password: NEW_PASSWORD });
  await page.goto('/account');
  await fillPasswordForm(page, 'another perfectly long password');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByTestId('password-outcome')).toHaveAttribute('data-outcome', 'alreadySet');
});
