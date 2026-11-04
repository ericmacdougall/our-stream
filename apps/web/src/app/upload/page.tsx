// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { UploadFlow } from '@/components/upload/UploadFlow';
import { requireMe } from '@/lib/api/require';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('nav.upload')} · ${t('app.name')}` };

export default async function UploadPage() {
  await requireMe('/upload');
  return (
    <main id="main" className="page">
      <header className="masthead">
        <h1>{t('nav.upload')}</h1>
        <p className="muted">{t('upload.intro')}</p>
      </header>
      <UploadFlow />
    </main>
  );
}
