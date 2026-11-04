// SPDX-License-Identifier: AGPL-3.0-only
// ICU message catalog scaffold. Locale negotiation and per-user language arrive with M1a/M7;
// every user-facing string goes through t() from day one so nothing is hard-coded in components.
import { createIntl, createIntlCache } from '@formatjs/intl';
import en from '../messages/en.json' with { type: 'json' };

const cache = createIntlCache();
const intl = createIntl({ locale: 'en', defaultLocale: 'en', messages: en }, cache);

export type MessageId = keyof typeof en;

export function t(id: MessageId, values?: Record<string, string | number>): string {
  return intl.formatMessage({ id, defaultMessage: en[id] }, values);
}
