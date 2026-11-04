// SPDX-License-Identifier: AGPL-3.0-only
// UI-driven helpers shared by the e2e specs. Everything goes through the real pages so the same
// suite runs against the mock and against a real API (E2E_API_URL).
import { expect, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_MP4 = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'tiny.mp4',
);

export interface Account {
  orgName: string;
  orgSlug: string;
  displayName: string;
  email: string;
  password: string;
}

export function uniqueAccount(prefix = 'e2e'): Account {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    orgName: `Org ${stamp}`,
    orgSlug: `${prefix}-${stamp}`.toLowerCase(),
    displayName: 'Test Owner',
    email: `${prefix}-${stamp}@example.test`,
    password: 'correct horse battery staple',
  };
}

export async function signUp(page: Page, account: Account) {
  await page.goto('/sign-up');
  await page.getByLabel('Organisation name').fill(account.orgName);
  await page.getByLabel('Organisation short name').fill(account.orgSlug);
  await page.getByLabel('Your name').fill(account.displayName);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await expect(page.getByRole('link', { name: 'Streams' })).toBeVisible();
}

export async function signIn(page: Page, account: Account) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/');
}

export async function createStream(page: Page, name: string, slug: string) {
  await page.goto('/streams');
  await page.getByLabel('Kind').selectOption('team');
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Short name').fill(slug);
  await page.getByRole('button', { name: 'Create stream' }).click();
  await expect(page.getByTestId('streams-list').getByRole('link', { name })).toBeVisible();
}

/** Uploads the fixture and waits for processing; returns the content id. */
export async function uploadClip(page: Page, title: string, options: { chapter?: boolean } = {}) {
  await page.goto('/upload');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Description').fill(`Description for ${title}`);
  if (options.chapter) {
    await page.getByRole('button', { name: 'Add chapter' }).click();
    // Both "00:02" and "0:02" are accepted; on blur the field shows the form viewers will see.
    await page.getByLabel('Chapter 1 time').fill('00:02');
    await page.getByLabel('Chapter 1 title').fill('Second chapter');
    await expect(page.getByLabel('Chapter 1 time')).toHaveValue('0:02');
  }
  await page.getByLabel('Video or audio file').setInputFiles(FIXTURE_MP4);
  await page.getByRole('button', { name: 'Create and upload' }).click();
  const status = page.getByTestId('processing-status');
  await expect(status).toHaveAttribute('data-status', 'current', { timeout: 90_000 });
  const link = page.getByRole('link', { name: 'Continue to publish' });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  const id = /\/content\/([^/]+)\/publish/.exec(href ?? '')?.[1];
  if (!id) throw new Error(`could not read content id from ${href}`);
  return id;
}

export async function publishToEveryone(page: Page, contentId: string) {
  await page.goto(`/content/${contentId}/publish`);
  await page.getByLabel('Everyone in the organisation').check();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/');
}

export function feedItem(page: Page, contentId: string) {
  return page.locator(`[data-testid="feed-item"][data-content-id="${contentId}"]`);
}
