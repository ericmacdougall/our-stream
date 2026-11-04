// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Organisation settings (owners/admins): viewing privacy mode (decision Q1), comments on/off and the
// comment scanner policy (ADR-0009). Only changed fields are sent; the server's answer replaces the
// form state. Engagement retention is operator-level and shown read-only.
import { useRef, useState, type FormEvent } from 'react';
import { t, type MessageId } from '@/lib/i18n';
import { updateOrgSettings, type Org } from '@/lib/m1b/api';
import { Notice } from '../Notice';

const PRIVACY: { value: Org['privacyMode']; label: MessageId }[] = [
  { value: 'identified_for_required_only', label: 'org.privacy.identified_for_required_only' },
  { value: 'aggregate_only', label: 'org.privacy.aggregate_only' },
  { value: 'named', label: 'org.privacy.named' },
];
const SCAN: { value: Org['commentScanPolicy']; label: MessageId }[] = [
  { value: 'off', label: 'org.scan.off' },
  { value: 'warn', label: 'org.scan.warn' },
  { value: 'block', label: 'org.scan.block' },
];

export function OrgSettingsForm({ initial }: { initial: Org }) {
  const [saved, setSaved] = useState<Org>(initial);
  const [privacyMode, setPrivacyMode] = useState<Org['privacyMode']>(initial.privacyMode);
  const [commentsEnabled, setCommentsEnabled] = useState(initial.commentsEnabled);
  const [scan, setScan] = useState<Org['commentScanPolicy']>(initial.commentScanPolicy);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const patch: Parameters<typeof updateOrgSettings>[0] = {};
    if (privacyMode !== saved.privacyMode) patch.privacyMode = privacyMode;
    if (commentsEnabled !== saved.commentsEnabled) patch.commentsEnabled = commentsEnabled;
    if (scan !== saved.commentScanPolicy) patch.commentScanPolicy = scan;
    if (Object.keys(patch).length === 0) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      const result = await updateOrgSettings(patch);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSaved(result.data);
      setPrivacyMode(result.data.privacyMode);
      setCommentsEnabled(result.data.commentsEnabled);
      setScan(result.data.commentScanPolicy);
      setStatus(t('org.saved'));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form
      method="post"
      onSubmit={(e) => void submit(e)}
      className="card form"
      noValidate
      aria-busy={pending}
    >
      <p className="muted">{t('org.intro')}</p>
      <div className="field">
        <label htmlFor="privacyMode">{t('org.privacyMode')}</label>
        <select
          id="privacyMode"
          value={privacyMode}
          disabled={pending}
          aria-describedby="privacy-hint"
          onChange={(e) => setPrivacyMode(e.target.value as Org['privacyMode'])}
        >
          {PRIVACY.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.label)}
            </option>
          ))}
        </select>
        <small id="privacy-hint" className="muted">
          {t('org.privacyHint')}
        </small>
      </div>
      <fieldset className="field" disabled={pending}>
        <legend>{t('org.comments')}</legend>
        <label className="inline">
          <input
            type="checkbox"
            checked={commentsEnabled}
            onChange={(e) => setCommentsEnabled(e.target.checked)}
            data-testid="org-comments"
          />{' '}
          {t('org.commentsOn')}
        </label>
      </fieldset>
      <div className="field">
        <label htmlFor="scan">{t('org.scan')}</label>
        <select
          id="scan"
          value={scan}
          disabled={pending}
          onChange={(e) => setScan(e.target.value as Org['commentScanPolicy'])}
        >
          {SCAN.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.label)}
            </option>
          ))}
        </select>
      </div>
      <dl className="meta">
        <dt>{t('org.retention')}</dt>
        <dd>{t('org.retentionValue', { days: saved.engagementRetentionDays })}</dd>
      </dl>
      <Notice kind="error">{error}</Notice>
      <Notice kind="success">{status}</Notice>
      <div className="actions">
        <button type="submit" className="primary" disabled={pending} data-testid="org-save">
          {pending ? t('common.working') : t('org.save')}
        </button>
      </div>
    </form>
  );
}
