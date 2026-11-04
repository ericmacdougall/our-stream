// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Interstitial for 'internet' links: shows where the link goes before leaving the org's space.
import { useEffect, useRef } from 'react';
import { externalHost } from '@/lib/links';
import { t } from '@/lib/i18n';

export function ExternalLinkDialog({
  url,
  label,
  onClose,
}: {
  url: string | null;
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (url && !dialog.open) dialog.showModal();
    if (!url && dialog.open) dialog.close();
  }, [url]);
  const host = url ? externalHost(url) : null;
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="external-heading" onClose={onClose}>
      <h2 id="external-heading">{t('feed.externalTitle')}</h2>
      {host ? (
        <p>{t('feed.externalBody', { label, host })}</p>
      ) : (
        <p role="alert">{t('feed.externalBlocked')}</p>
      )}
      <div className="actions">
        <button type="button" onClick={onClose}>
          {t('common.cancel')}
        </button>
        {host && url ? (
          <a
            className="button primary"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
          >
            {t('feed.externalContinue')}
          </a>
        ) : null}
      </div>
    </dialog>
  );
}
