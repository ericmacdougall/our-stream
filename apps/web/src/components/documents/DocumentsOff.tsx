// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import { t } from '@/lib/i18n';

/** Shown instead of the documents UI while the org flag is off (members and admins alike). */
export function DocumentsOff({ canManage }: { canManage: boolean }) {
  return (
    <section className="card" aria-labelledby="documents-off-heading" data-testid="documents-off">
      <h2 id="documents-off-heading">{t('documents.disabledTitle')}</h2>
      <p>{t('documents.disabledBody')}</p>
      {canManage ? (
        <p>
          <Link href="/settings">{t('documents.disabledAdmin')}</Link>
        </p>
      ) : null}
    </section>
  );
}
