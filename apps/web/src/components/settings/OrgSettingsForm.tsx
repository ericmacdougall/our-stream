// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Organisation settings for owners and admins; only the documents switch exists in M2a. The switch is a
// checkbox whose change is sent once at a time (a ref guards double input) and is reverted when the API
// refuses, e.g. 403 `feature_disabled` while the deployment kill switch is engaged.
import { useRef, useState } from 'react';
import { browserApi, errorCode } from '@/lib/api/client';
import { describeError } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { Notice } from '../Notice';

export function OrgSettingsForm({ initialDocumentsEnabled }: { initialDocumentsEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialDocumentsEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function change(next: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    const previous = enabled;
    setEnabled(next);
    setPending(true);
    setError(null);
    setSaved(null);
    try {
      const result = await browserApi().PATCH('/v1/org/settings', {
        body: { documentsEnabled: next },
      });
      if (!result.data) {
        setEnabled(previous);
        const code = errorCode(result.error);
        setError(
          code === 'feature_disabled'
            ? t('settings.killSwitch')
            : describeError(code, result.response.status),
        );
        return;
      }
      setEnabled(result.data.documentsEnabled);
      setSaved(
        t(result.data.documentsEnabled ? 'settings.documentsOn' : 'settings.documentsOffNow'),
      );
    } catch {
      setEnabled(previous);
      setError(t('error.network'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => e.preventDefault()} aria-busy={pending}>
      <h2>{t('settings.documentsLabel')}</h2>
      <label className="inline">
        <input
          type="checkbox"
          name="documentsEnabled"
          checked={enabled}
          disabled={pending}
          aria-describedby="documents-hint"
          onChange={(e) => void change(e.target.checked)}
        />{' '}
        {t('settings.documentsToggle')}
      </label>
      <small id="documents-hint" className="muted">
        {t('settings.documentsHint')}
      </small>
      <Notice kind="error">{error}</Notice>
      <Notice kind="success">{saved}</Notice>
    </form>
  );
}
