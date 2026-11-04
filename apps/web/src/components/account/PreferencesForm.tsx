// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Notification preference: the daily email digest (worker-side batching, deduped per user/day).
// Saved on change; the server's answer is the truth, a refusal restores the previous choice.
import { useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { updatePreferences, type Preferences } from '@/lib/m1b/api';
import { Notice } from '../Notice';

export function PreferencesForm({ initial }: { initial: Preferences | null }) {
  const [digest, setDigest] = useState<Preferences['emailDigest']>(initial?.emailDigest ?? 'daily');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function choose(next: Preferences['emailDigest']) {
    if (inFlight.current || next === digest) return;
    const previous = digest;
    inFlight.current = true;
    setPending(true);
    setDigest(next);
    setError(null);
    setStatus(null);
    try {
      const result = await updatePreferences({ emailDigest: next });
      if (!result.ok) {
        setDigest(previous);
        setError(result.message);
        return;
      }
      setDigest(result.data.emailDigest);
      setStatus(t('prefs.saved'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section className="card" aria-labelledby="prefs-heading" data-testid="preferences">
      <h2 id="prefs-heading">{t('prefs.heading')}</h2>
      <p className="muted">{t('prefs.intro')}</p>
      <fieldset className="field" disabled={pending}>
        <legend className="visually-hidden">{t('prefs.heading')}</legend>
        <label className="inline">
          <input
            type="radio"
            name="emailDigest"
            value="daily"
            checked={digest === 'daily'}
            onChange={() => void choose('daily')}
          />{' '}
          {t('prefs.daily')}
        </label>
        <label className="inline">
          <input
            type="radio"
            name="emailDigest"
            value="off"
            checked={digest === 'off'}
            onChange={() => void choose('off')}
          />{' '}
          {t('prefs.off')}
        </label>
      </fieldset>
      <Notice kind="error">{error}</Notice>
      <Notice kind="success">{status}</Notice>
    </section>
  );
}
