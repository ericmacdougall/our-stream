// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { renderDigest } from './digest.js';
import { FakeMailer } from './mailer.js';

const base = {
  to: 'a@example.invalid',
  displayName: 'Ada',
  appBaseUrl: 'https://os.example',
  day: '2026-11-04',
};

describe('digest rendering', () => {
  it('names visible items with links and keeps lost-access items neutral and link-free', () => {
    const m = renderDigest({
      ...base,
      items: [
        {
          id: '1',
          kind: 'content.published',
          reason: 'audience',
          contentId: 'c1',
          title: 'Budget "Q4"',
          createdAt: '2026-11-04T10:00:00Z',
        },
        {
          id: '2',
          kind: 'content.published',
          reason: 'audience',
          contentId: 'c2',
          title: null,
          createdAt: '2026-11-04T09:00:00Z',
        },
        {
          id: '3',
          kind: 'comment.created',
          reason: 'replied',
          contentId: 'c1',
          title: 'Budget "Q4"',
          createdAt: '2026-11-04T11:00:00Z',
        },
        {
          id: '4',
          kind: 'content.retracted',
          reason: 'saw_version',
          contentId: 'c3',
          title: null,
          createdAt: '2026-11-04T12:00:00Z',
        },
      ],
    });
    expect(m.subject).toBe('our-stream: 4 new items (2026-11-04)');
    expect(m.text).toContain('New: "Budget \\"Q4\\""\n  https://os.example/content/c1');
    expect(m.text).toContain('Someone replied to your comment on');
    expect(m.text).toContain('An item you can no longer view had an update.');
    expect(m.text).toContain('Something you viewed has been withdrawn.');
    expect(m.text).not.toContain('/content/c2');
    expect(m.text).not.toContain('/content/c3');
    // Oldest first.
    expect(m.text.indexOf('no longer view')).toBeLessThan(m.text.indexOf('New: '));
  });

  it('fake mailer records sends and can fail on demand', async () => {
    const f = new FakeMailer();
    f.failNext(1);
    await expect(f.send({ to: 'x', subject: 's', text: 't' })).rejects.toThrow(/simulated/);
    await f.send({ to: 'x', subject: 's', text: 't' });
    expect(f.to('x')).toHaveLength(1);
  });
});
