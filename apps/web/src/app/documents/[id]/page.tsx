// SPDX-License-Identifier: AGPL-3.0-only
import { notFound } from 'next/navigation';
import { DocumentViewer } from '@/components/documents/DocumentViewer';
import { Notice } from '@/components/Notice';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';
import { t } from '@/lib/i18n';

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMe(`/documents/${id}`);
  const api = await serverApi();
  const result = await api.GET('/v1/content/{id}/document', { params: { path: { id } } });
  // The API answers one neutral 404 for every document the caller may not open (hidden, missing, flag off,
  // not a document); the page shows the same not-found page as a missing clip and reveals nothing more.
  if (result.response.status === 404) notFound();
  if (!result.data) {
    return (
      <main id="main" className="page">
        <Notice kind="error">{t('error.generic')}</Notice>
      </main>
    );
  }
  return (
    <main id="main" className="page">
      <DocumentViewer initial={result.data} />
    </main>
  );
}
