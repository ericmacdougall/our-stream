// SPDX-License-Identifier: AGPL-3.0-only
// M2a documents UI against the mock API (AC-1, AC-6, AC-7, AC-9 UI parts): upload of every kind, refusals,
// failed processing, publish notice, viewer anchors and plain-text rendering, download, list and search,
// the neutral 404, and the flag/kill-switch blocking. Mock only: the real API needs a database and a
// worker to parse, which this suite does not start.
import { expect, test, type Page } from '@playwright/test';
import {
  createStream,
  fixturePath,
  mock,
  publishToStream,
  signUp,
  streamIdFor,
  uniqueAccount,
  uploadDocument,
} from './helpers';

test.skip(Boolean(process.env['E2E_API_URL']), 'document specs use the mock API knobs');

const KINDS: { file: string; format: string }[] = [
  { file: 'sample.pdf', format: 'PDF' },
  { file: 'sample.docx', format: 'Word (DOCX)' },
  { file: 'sample.pptx', format: 'PowerPoint (PPTX)' },
  { file: 'sample.xlsx', format: 'Excel (XLSX)' },
  { file: 'sample.csv', format: 'CSV' },
  { file: 'sample.md', format: 'Markdown' },
];

function trackRequests(page: Page) {
  const seen: { method: string; path: string; body: string | null }[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/')) {
      seen.push({ method: r.method(), path: url.pathname, body: r.postData() });
    }
  });
  return seen;
}

async function ownerWithStream(page: Page, prefix: string, streamName = 'Docs') {
  await signUp(page, uniqueAccount(prefix));
  await createStream(page, streamName, streamName.toLowerCase());
  return streamIdFor(page, streamName);
}

test('every document kind uploads, processes and shows its file details (AC-1)', async ({
  page,
}) => {
  await signUp(page, uniqueAccount('kinds'));
  const requests = trackRequests(page);
  for (const { file, format } of KINDS) {
    const id = await uploadDocument(page, `Kind ${file}`, file);
    await page.goto(`/content/${id}`);
    await expect(page.getByTestId('document-file')).toHaveText(file);
    await expect(page.getByText(format, { exact: true })).toBeVisible();
    await expect(page.locator('#not-scanned-notice')).toContainText('not scanned');
  }
  const creates = requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/content');
  expect(creates).toHaveLength(KINDS.length);
  for (const c of creates) expect(JSON.parse(c.body ?? '{}')).toMatchObject({ kind: 'document' });
});

test('a double click creates and uploads once (single-flight)', async ({ page }) => {
  await signUp(page, uniqueAccount('once'));
  const requests = trackRequests(page);
  await page.goto('/upload');
  await page.getByLabel('Title').fill('Once');
  await page.getByLabel('Video, audio or document file').setInputFiles(fixturePath('sample.pdf'));
  await page.getByRole('button', { name: 'Create and upload' }).dblclick();
  await expect(page.getByTestId('processing-status')).toHaveAttribute('data-status', 'current', {
    timeout: 90_000,
  });
  expect(requests.filter((r) => r.path === '/api/v1/content' && r.method === 'POST')).toHaveLength(
    1,
  );
  expect(requests.filter((r) => r.path.endsWith('/upload/init'))).toHaveLength(1);
  expect(requests.filter((r) => r.path.endsWith('/upload/complete'))).toHaveLength(1);
});

test('two submits in the same tick still create and upload once (guard, not just a disabled button)', async ({
  page,
}) => {
  await signUp(page, uniqueAccount('tick'));
  const requests = trackRequests(page);
  await page.goto('/upload');
  await page.getByLabel('Title').fill('Same tick');
  await page.getByLabel('Video, audio or document file').setInputFiles(fixturePath('sample.pdf'));
  await page.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) throw new Error('no form');
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.getByTestId('processing-status')).toHaveAttribute('data-status', 'current', {
    timeout: 90_000,
  });
  expect(requests.filter((r) => r.path === '/api/v1/content' && r.method === 'POST')).toHaveLength(
    1,
  );
  expect(requests.filter((r) => r.path.endsWith('/upload/init'))).toHaveLength(1);
});

test('refused files never reach the API: legacy Office, oversize, disguised names', async ({
  page,
}) => {
  await signUp(page, uniqueAccount('refuse'));
  const requests = trackRequests(page);
  await page.goto('/upload');
  await page.getByLabel('Title').fill('Refused');
  const picker = page.getByLabel('Video, audio or document file');
  const submit = page.getByRole('button', { name: 'Create and upload' });

  await picker.setInputFiles(fixturePath('legacy.doc'));
  await expect(page.locator('.notice-error')).toContainText('Old Office files (.doc, .ppt, .xls)');
  await expect(submit).toBeDisabled();

  await picker.setInputFiles({
    name: 'evil.pdf\u202Egpj.exe',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4'),
  });
  await expect(page.locator('.notice-error')).toContainText('not a video, audio or document type');
  await expect(submit).toBeDisabled();

  // 100 MiB + 1 byte, built inside the page (Playwright caps buffer uploads at 50 MB).
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#file');
    if (!input) throw new Error('no file input');
    const big = new File([new Uint8Array(100 * 1024 * 1024 + 1)], 'big.pdf', {
      type: 'application/pdf',
    });
    const dt = new DataTransfer();
    dt.items.add(big);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.notice-error')).toContainText('larger than 100 MiB');
  await expect(submit).toBeDisabled();

  await picker.setInputFiles(fixturePath('sample.pdf'));
  await expect(page.locator('.notice-error')).toHaveCount(0);
  await expect(submit).toBeEnabled();
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
});

test('API refusals map to clear messages (quota, size, type, switched off)', async ({ page }) => {
  await signUp(page, uniqueAccount('errors'));
  const attempt = async (title: string) => {
    await page.goto('/upload');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Video, audio or document file').setInputFiles(fixturePath('sample.pdf'));
    await page.getByRole('button', { name: 'Create and upload' }).click();
  };

  await mock('/__mock/quota', { exceeded: true });
  await attempt('Quota');
  await expect(page.locator('.notice-error')).toContainText('used its document storage');
  await mock('/__mock/quota', { exceeded: false });

  await mock('/__mock/fail-next', { match: 'upload/init$', status: 413, code: 'file_too_large' });
  await attempt('Too large');
  await expect(page.locator('.notice-error')).toContainText('too large');

  await mock('/__mock/fail-next', {
    match: 'upload/init$',
    status: 400,
    code: 'unsupported_file_type',
  });
  await attempt('Type');
  await expect(page.locator('.notice-error')).toContainText('not supported');

  await mock('/__mock/kill-switch', { on: true });
  await attempt('Kill');
  await expect(page.locator('.notice-error')).toContainText('switched off');
  await mock('/__mock/kill-switch', { on: false });
});

test('a document without text shows its failure reason to the owner and is not readable (AC-6)', async ({
  page,
}) => {
  await signUp(page, uniqueAccount('notext'));
  const id = await uploadDocument(page, 'Scan', 'notext.pdf', 'failed');
  await expect(page.getByTestId('processing-status')).toContainText('no readable text');
  await page.goto(`/content/${id}`);
  await expect(page.getByTestId('processing-status')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('processing-status')).toContainText('no readable text');
  await expect(
    page.getByText('Only you and other editors can see this failed version.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Publish' })).toHaveCount(0);
  const res = await page.goto(`/documents/${id}`);
  expect(res?.status()).toBe(404);
});

test('publish shows the not-scanned notice; viewer shows anchors as plain text; download is an attachment (AC-7, AC-9)', async ({
  page,
}) => {
  await ownerWithStream(page, 'view');
  const evil = [
    '# <script>window.__pwned = 1</script>',
    '<img src=x onerror="window.__pwned = 1">quarterly budget as markup',
    '',
    '## Second',
    'More text.',
  ].join('\n');
  const id = await uploadDocument(page, 'Markup doc', {
    name: 'markup.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(evil),
  });
  await page.goto(`/content/${id}/publish`);
  await expect(page.locator('#not-scanned-notice')).toContainText(
    'not scanned for personal data or secrets',
  );
  await publishToStream(page, id, 'Docs');
  await expect(page.getByTestId('content-state')).toHaveText('Published');

  await page.goto(`/documents/${id}`);
  const sections = page.getByTestId('document-sections').locator('section');
  await expect(sections).toHaveCount(2);
  await expect(sections.first().getByRole('heading', { level: 2 })).toHaveText(
    '<script>window.__pwned = 1</script>',
  );
  await expect(sections.first()).toContainText('<img src=x onerror="window.__pwned = 1">');
  // Markup is text: no element was created from it and nothing ran.
  expect(
    await page
      .locator('[data-testid="document-sections"] script, [data-testid="document-sections"] img')
      .count(),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  await expect(page.locator('#not-scanned-notice')).toBeVisible();
  await expect(page.getByTestId('document-end')).toBeVisible();

  // The original is only an attachment download.
  const link = page.getByTestId('download-original');
  await expect(link).toHaveAttribute('href', `/api/v1/content/${id}/document/original`);
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe('markup.md');
  const original = await page.request.get(`/api/v1/content/${id}/document/original`);
  expect(original.status()).toBe(200);
  expect(original.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(original.headers()['x-content-type-options']).toBe('nosniff');
  expect(original.headers()['content-type']).toBe('text/markdown');
});

test('anchors for pages, slides, sheets and headings are shown and linked', async ({ page }) => {
  await ownerWithStream(page, 'anchors');
  const cases: [string, string[]][] = [
    ['sample.pdf', ['Page 1', 'Page 2', 'Page 3']],
    ['sample.pptx', ['Slide 1', 'Slide 2']],
    ['sample.xlsx', ['Budget rows 1-2', 'Budget rows 3-4']],
    ['sample.docx', ['Overview', 'Budget']],
    ['sample.csv', ['Rows 1-2', 'Rows 3-4']],
  ];
  for (const [file, labels] of cases) {
    const id = await uploadDocument(page, `Anchors ${file}`, file);
    await publishToStream(page, id, 'Docs');
    await page.goto(`/documents/${id}`);
    const jump = page.getByRole('navigation', { name: 'Jump to' });
    for (const label of labels) {
      await expect(jump.getByRole('link', { name: label, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: label, exact: true })).toBeVisible();
    }
  }
});

test('long documents page by cursor without duplicating sections', async ({ page }) => {
  await ownerWithStream(page, 'paging');
  const md = Array.from({ length: 260 }, (_, i) => `# Part ${i + 1}\nBody ${i + 1}`).join('\n');
  const id = await uploadDocument(page, 'Long', {
    name: 'long.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(md),
  });
  await publishToStream(page, id, 'Docs');
  await page.goto(`/documents/${id}`);
  const sections = page.getByTestId('document-sections').locator('section');
  await expect(sections).toHaveCount(200);
  await expect(page.getByTestId('document-end')).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more text' }).click();
  await expect(sections).toHaveCount(260);
  await expect(page.getByTestId('document-end')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more text' })).toHaveCount(0);
});

test('hidden and missing documents show the same not-found page as a missing clip (AC-7)', async ({
  page,
}) => {
  await ownerWithStream(page, 'parity');
  const draft = await uploadDocument(page, 'Draft doc', 'sample.pdf');
  const missing = '00000000-0000-4000-8000-000000000001';

  async function snapshot(path: string) {
    const res = await page.goto(path);
    return { status: res?.status(), text: (await page.locator('body').innerText()).trim() };
  }
  const clipNotFound = await snapshot(`/content/${missing}`);
  const draftDoc = await snapshot(`/documents/${draft}`);
  const missingDoc = await snapshot(`/documents/${missing}`);
  expect(clipNotFound.status).toBe(404);
  expect(draftDoc.status).toBe(404);
  expect(missingDoc.status).toBe(404);
  expect(draftDoc.text).toBe(missingDoc.text);
  // Same page as a missing clip apart from the signed-in navigation both share.
  expect(draftDoc.text).toBe(clipNotFound.text);
});

test('stream list and keyword search show published documents with counts and safe snippets', async ({
  page,
}) => {
  const streamId = await ownerWithStream(page, 'search');
  const first = await uploadDocument(page, 'Budget handbook', 'sample.md');
  await publishToStream(page, first, 'Docs');
  const second = await uploadDocument(page, '<b>budget</b> plan', 'sample.pdf');
  await publishToStream(page, second, 'Docs');
  const unrelated = await uploadDocument(page, 'Unrelated', 'sample.csv');
  await publishToStream(page, unrelated, 'Docs');
  await uploadDocument(page, 'Secret draft budget', 'sample.docx');

  await page.goto(`/streams/${streamId}/documents`);
  const items = page.getByTestId('document-item');
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: 'Secret draft budget' })).toHaveCount(0);

  await page.goto('/documents');
  await page.getByLabel('Search documents').fill('budget');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/documents\?q=budget$/);
  await expect(page.getByTestId('results-count')).toHaveText('2 documents found');
  const results = page.getByTestId('result');
  await expect(results).toHaveCount(2);
  await expect(results.filter({ hasText: 'Secret draft budget' })).toHaveCount(0);
  expect(await page.locator('mark').count()).toBeGreaterThan(0);
  // Snippet and title markup stays text.
  await expect(page.getByRole('link', { name: '<b>budget</b> plan' })).toBeVisible();
  expect(await page.locator('[data-testid="results"] b').count()).toBe(0);
  const marked = await page.locator('mark').allTextContents();
  expect(marked.every((m) => m.toLowerCase() === 'budget')).toBe(true);
  // Anchored text hits say where they are.
  await expect(page.getByText('(Page 1)').first()).toBeVisible();

  // The query lives only in the URL.
  expect(
    await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].some((v) =>
        v.includes('budget'),
      ),
    ),
  ).toBe(false);
  expect(
    await page
      .context()
      .cookies()
      .then((c) => c.some((x) => x.value.includes('budget'))),
  ).toBe(false);

  await results.first().getByRole('link').click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/);
});

test('invalid queries are refused before any request; 429 is explained', async ({ page }) => {
  await signUp(page, uniqueAccount('query'));
  const before = Number((await mock('/__mock/state'))['searchCalls']);
  await page.goto('/documents?q=%20%20');
  await expect(page.locator('.notice-error')).toContainText('Enter a word or phrase');
  await page.goto(`/documents?q=${'x'.repeat(2001)}`);
  await expect(page.locator('.notice-error')).toContainText('at most 2,000 characters');
  expect(Number((await mock('/__mock/state'))['searchCalls'])).toBe(before);

  await mock('/__mock/fail-next', { match: 'search/documents', status: 429, code: 'rate_limited' });
  await page.goto('/documents?q=budget');
  await expect(page.locator('.notice-error')).toContainText('searching too quickly');
  await page.goto('/documents?q=budget');
  await expect(page.getByTestId('results-count')).toHaveText('No documents found');
});

test('the documents switch blocks upload, list, search and viewer when off (AC-8 UI)', async ({
  page,
}) => {
  const streamId = await ownerWithStream(page, 'flag');
  const id = await uploadDocument(page, 'Flag doc', 'sample.pdf');
  await publishToStream(page, id, 'Docs');

  await page.goto('/settings');
  const toggle = page.getByLabel('Documents enabled');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.locator('.notice-success')).toContainText('Documents are off.');
  await expect(toggle).not.toBeChecked();

  await page.goto('/documents');
  await expect(page.getByTestId('documents-off')).toContainText('switched documents off');
  await expect(page.getByLabel('Search documents')).toHaveCount(0);
  await page.goto(`/streams/${streamId}/documents`);
  await expect(page.getByTestId('documents-off')).toBeVisible();
  const viewer = await page.goto(`/documents/${id}`);
  expect(viewer?.status()).toBe(404);

  // A document file is blocked before any request; media files are untouched.
  const requests = trackRequests(page);
  await page.goto('/upload');
  await page.getByLabel('Title').fill('Blocked');
  await page.getByLabel('Video, audio or document file').setInputFiles(fixturePath('sample.pdf'));
  await expect(page.locator('.notice-error')).toContainText('Documents are switched off');
  await expect(page.getByRole('button', { name: 'Create and upload' })).toBeDisabled();
  await page.getByLabel('Video, audio or document file').setInputFiles(fixturePath('tiny.mp4'));
  await expect(page.getByRole('button', { name: 'Create and upload' })).toBeEnabled();
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);

  // Turning it back on restores the document.
  await page.goto('/settings');
  await page.getByLabel('Documents enabled').check();
  await expect(page.locator('.notice-success')).toContainText('Documents are on.');
  const again = await page.goto(`/documents/${id}`);
  expect(again?.status()).toBe(200);
});

test('settings cannot turn documents on while the deployment kill switch is engaged', async ({
  page,
}) => {
  await signUp(page, uniqueAccount('kill'));
  await page.goto('/settings');
  await page.getByLabel('Documents enabled').uncheck();
  await expect(page.locator('.notice-success')).toContainText('Documents are off.');
  await mock('/__mock/kill-switch', { on: true });
  await page.getByLabel('Documents enabled').check();
  await expect(page.locator('.notice-error')).toContainText('whole deployment');
  await expect(page.getByLabel('Documents enabled')).not.toBeChecked();
  await mock('/__mock/kill-switch', { on: false });
});
