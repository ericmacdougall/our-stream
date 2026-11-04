// SPDX-License-Identifier: AGPL-3.0-only
// Event tag labels. A plain module (no 'use client') so server components such as FeedFilters can
// read it: importing a value from a client module into a server component yields a client
// reference, not the object.
import type { MessageId } from '@/lib/i18n';
import type { Tag } from './search';

export const TAG_LABEL: Record<Tag, MessageId> = {
  onboarding: 'tag.onboarding',
  announcement: 'tag.announcement',
  'current-events': 'tag.current-events',
  training: 'tag.training',
};
