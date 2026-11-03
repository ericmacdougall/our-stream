// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('app.name'),
  description: t('app.tagline'),
  applicationName: 'our-stream',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f5' },
    { media: '(prefers-color-scheme: dark)', color: '#121311' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          {t('a11y.skipToContent')}
        </a>
        {children}
      </body>
    </html>
  );
}
