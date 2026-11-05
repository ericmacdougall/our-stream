// SPDX-License-Identifier: AGPL-3.0-only
// Keyboard-only path and axe checks for the M2a document pages (mock API only).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  createStream,
  fixturePath,
  publishToStream,
  signUp,
  streamIdFor,
  uniqueAccount,
  uploadDocument,
} from './helpers';

test.skip(Boolean(process.env['E2E_API_URL']), 'document specs use the mock API');

async function expectNoSeriousViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  test.info().annotations.push({
    type: `axe:${label}`,
    description: `${results.violations.length} violations, ${serious.length} serious/critical`,
  });
  expect(
    serious.map(
      (v) => `${v.id}: ${v.help} (${v.nodes.length} nodes) ${v.nodes[0]?.target.join(' ')}`,
    ),
    label,
  ).toEqual([]);
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}#${el.id}|${el.textContent?.trim().slice(0, 40)}` : '';
  });

async function tabUntil(page: Page, predicate: (desc: string) => boolean, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (predicate(await focused(page))) return;
  }
  throw new Error(`focus never reached the target; last: ${await focused(page)}`);
}

test('upload and viewer work from the keyboard alone, with a visible focus ring', async ({
  page,
}) => {
  await signUp(page, uniqueAccount('kbd'));
  await createStream(page, 'Docs', 'docs');

  // Upload: reach the title, the file input and the submit button by Tab; Enter submits.
  await page.goto('/upload');
  await tabUntil(page, (d) => d.startsWith('input#title'));
  await page.keyboard.type('Keyboard doc');
  await tabUntil(page, (d) => d.startsWith('input#file'));
  // The native file dialog cannot be driven; the focused input receives the file.
  await page.locator('#file').setInputFiles(fixturePath('sample.pdf'));
  await tabUntil(page, (d) => d.includes('Create and upload'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('processing-status')).toHaveAttribute('data-status', 'current', {
    timeout: 90_000,
  });
  const href = await page.getByRole('link', { name: 'View document' }).getAttribute('href');
  const id = /\/content\/([^/]+)$/.exec(href ?? '')?.[1] ?? '';
  expect(id).not.toBe('');
  await publishToStream(page, id, 'Docs');

  // Viewer: Tab reaches the download link and the jump links; Enter on a jump link moves to its section.
  await page.goto(`/documents/${id}`);
  await tabUntil(page, (d) => d.startsWith('a#|Download original'));
  const ring = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement as Element);
    return { width: parseFloat(s.outlineWidth), style: s.outlineStyle };
  });
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(ring.style).not.toBe('none');
  await tabUntil(page, (d) => d.startsWith('a#|Page 2'));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#s-1$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Page 2' })).toBeInViewport();
});

test('load more is reachable and operable from the keyboard', async ({ page }) => {
  await signUp(page, uniqueAccount('kbdmore'));
  await createStream(page, 'Docs', 'docs');
  const md = Array.from({ length: 220 }, (_, i) => `# Part ${i + 1}\nBody`).join('\n');
  const id = await uploadDocument(page, 'Long', {
    name: 'long.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(md),
  });
  await publishToStream(page, id, 'Docs');
  await page.goto(`/documents/${id}`);
  const sections = page.getByTestId('document-sections').locator('section');
  await expect(sections).toHaveCount(200);
  await page.getByRole('button', { name: 'Load more text' }).focus();
  await page.keyboard.press('Space');
  await expect(sections).toHaveCount(220);
});

test('new document pages have no serious accessibility violations', async ({ page }) => {
  await signUp(page, uniqueAccount('axe-doc'));
  await createStream(page, 'Docs', 'docs');
  const streamId = await streamIdFor(page, 'Docs');

  await page.goto('/upload');
  await page.getByLabel('Title').fill('Axe doc');
  await page.getByLabel('Video, audio or document file').setInputFiles(fixturePath('legacy.doc'));
  await expect(page.locator('.notice-error')).toBeVisible();
  await expectNoSeriousViolations(page, 'upload-refused');

  const id = await uploadDocument(page, 'Axe doc', 'sample.pdf');
  await page.goto(`/content/${id}`);
  await expectNoSeriousViolations(page, 'content-document');
  await page.goto(`/content/${id}/publish`);
  await expectNoSeriousViolations(page, 'publish-document');
  await publishToStream(page, id, 'Docs');

  await page.goto(`/documents/${id}`);
  await expectNoSeriousViolations(page, 'viewer');
  await page.goto(`/streams/${streamId}/documents`);
  await expectNoSeriousViolations(page, 'stream-documents');
  await page.goto('/documents?q=budget');
  await expect(page.getByTestId('results-count')).toBeVisible();
  await expect(page.locator('mark').first()).toBeVisible();
  await expectNoSeriousViolations(page, 'search-results');
  await page.goto('/documents?q=%20');
  await expectNoSeriousViolations(page, 'search-invalid');
  await page.goto('/settings');
  await expectNoSeriousViolations(page, 'settings');
  await page.getByLabel('Documents enabled').uncheck();
  await expect(page.locator('.notice-success')).toBeVisible();
  await page.goto('/documents');
  await expect(page.getByTestId('documents-off')).toBeVisible();
  await expectNoSeriousViolations(page, 'documents-off');
});
