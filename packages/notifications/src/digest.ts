// SPDX-License-Identifier: AGPL-3.0-only
// Daily digest rendering (ADR-0005 §5/§6). Items arrive with `title` already permission-checked by the
// database (null when the recipient cannot currently view the item), so a null title renders as a
// neutral line without a link, name or stream. Actors are never named ("Someone"): the digest is a
// pointer back into the app, not a copy of its content.
import type { MailMessage } from './mailer.js';

export interface DigestItem {
  id: string;
  kind: string;
  reason: string;
  contentId: string | null;
  /** Live title if the recipient passes readerVisible at build time, otherwise null. */
  title: string | null;
  createdAt: string;
}

export interface DigestInput {
  to: string;
  displayName: string;
  appBaseUrl: string;
  /** ISO date (YYYY-MM-DD) the digest covers. */
  day: string;
  items: DigestItem[];
}

const NEUTRAL = 'An item you can no longer view had an update.';

function line(item: DigestItem, appBaseUrl: string): string {
  if (item.title === null || item.contentId === null) {
    if (item.kind === 'content.retracted') return 'Something you viewed has been withdrawn.';
    return NEUTRAL;
  }
  const link = `${appBaseUrl.replace(/\/$/, '')}/content/${item.contentId}`;
  const title = JSON.stringify(item.title); // quotes and escapes control characters in a text mail
  switch (item.kind) {
    case 'content.published':
      return `New: ${title}\n  ${link}`;
    case 'content.shared':
      return `A colleague shared ${title} with you\n  ${link}`;
    case 'comment.created':
      return item.reason === 'replied'
        ? `Someone replied to your comment on ${title}\n  ${link}`
        : `Someone commented on ${title}\n  ${link}`;
    case 'content.retracted':
      return `${title} has been withdrawn.`;
    default:
      return `Update on ${title}\n  ${link}`;
  }
}

export function renderDigest(input: DigestInput): MailMessage {
  const items = [...input.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const n = items.length;
  const subject = `our-stream: ${n} new ${n === 1 ? 'item' : 'items'} (${input.day})`;
  const body = [
    `Hello ${input.displayName},`,
    '',
    `${n === 1 ? 'One thing' : `${n} things`} happened on ${input.day}:`,
    '',
    ...items.map((i) => `- ${line(i, input.appBaseUrl)}`),
    '',
    `Open our-stream: ${input.appBaseUrl}`,
    'You receive this daily digest because of your notification preference; turn it off under Account > Notifications.',
  ].join('\n');
  return { to: input.to, subject, text: body };
}
