// SPDX-License-Identifier: AGPL-3.0-only
// Feed layout: the Like / Comments / Share row must be reachable by a real mouse click at its
// laid-out position, with no scrolling of an inner box, at common laptop/desktop/phone sizes.
// Regression for the click-test defect where `.feed-meta` was a 69 px scroll box holding 154 px.
import { expect, test } from '@playwright/test';
import { feedItem, publishToEveryone, signUp, uniqueAccount, uploadClip } from './helpers';

const VIEWPORTS = [
  { width: 1470, height: 773 },
  { width: 1280, height: 600 },
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

test('like/comments/share are clickable by a real mouse click without scrolling an inner box', async ({
  page,
}) => {
  await signUp(page, uniqueAccount('layout'));
  const id = await uploadClip(
    page,
    `Layout clip ${'with a rather long wrapping title '.repeat(4)}`,
    {
      description: 'A long description. '.repeat(40),
    },
  );
  await publishToEveryone(page, id);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const item = feedItem(page, id);
    await expect(item).toBeVisible();
    const label = `${viewport.width}x${viewport.height}`;

    for (const testId of ['like-button', 'comments-button', 'share-button']) {
      const button = item.getByTestId(testId);
      await expect(button, `${label} ${testId}`).toBeVisible();
      const box = await button.boundingBox();
      if (!box) throw new Error(`${label}: no box for ${testId}`);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      expect(y, `${label} ${testId} inside the viewport`).toBeLessThan(viewport.height);
      // The topmost element at the button's centre must be the button itself, not the article
      // or a clipped scroll container.
      const hit = await button.evaluate(
        (el, [px, py]) => {
          const top = document.elementFromPoint(px as number, py as number);
          return top !== null && (top === el || el.contains(top));
        },
        [x, y],
      );
      expect(hit, `${label} ${testId} is the element under the pointer`).toBe(true);
    }

    // No scroll box may hide any part of the action row.
    const clipped = await item.evaluate((article) => {
      const bar = article.querySelector('.reaction-bar');
      if (!bar) return 'no reaction bar';
      const barRect = bar.getBoundingClientRect();
      for (let el = bar.parentElement; el && el !== article; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowY !== 'visible') {
          const r = el.getBoundingClientRect();
          if (barRect.top < r.top - 1 || barRect.bottom > r.bottom + 1) {
            return `${el.className} clips the action row`;
          }
        }
      }
      return null;
    });
    expect(clipped, label).toBeNull();

    // The video keeps a usable area: the meta block must not squeeze it to a sliver.
    const mediaHeight = await item.locator('.feed-media').evaluate((el) => el.clientHeight);
    expect(mediaHeight, `${label} video area height`).toBeGreaterThanOrEqual(120);

    // A real mouse click at the button's position toggles the like.
    const like = item.getByTestId('like-button');
    const box = await like.boundingBox();
    if (!box) throw new Error('no like box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(like, label).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(like, label).toHaveAttribute('aria-pressed', 'false');
  }
});
