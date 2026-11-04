// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useId } from 'react';
import { t, type MessageId } from '@/lib/i18n';

export type LinkKind = 'intranet' | 'internet' | 'attachment';
export interface LinkDraft {
  key: number;
  kind: LinkKind;
  url: string;
  label: string;
}

export const LINK_KINDS: LinkKind[] = ['intranet', 'internet', 'attachment'];
export const LINK_KIND_LABEL: Record<LinkKind, MessageId> = {
  intranet: 'links.kind.intranet',
  internet: 'links.kind.internet',
  attachment: 'links.kind.attachment',
};

export function LinksEditor({
  links,
  onChange,
  disabled,
}: {
  links: LinkDraft[];
  onChange: (links: LinkDraft[]) => void;
  disabled?: boolean;
}) {
  const baseId = useId();
  function update(key: number, patch: Partial<LinkDraft>) {
    onChange(links.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  return (
    <fieldset className="field">
      <legend>{t('upload.links')}</legend>
      {links.map((l, i) => (
        <div key={l.key} className="row">
          <label htmlFor={`${baseId}-kind-${l.key}`} className="visually-hidden">
            {t('upload.linkKind', { n: i + 1 })}
          </label>
          <select
            id={`${baseId}-kind-${l.key}`}
            value={l.kind}
            disabled={disabled}
            onChange={(e) => update(l.key, { kind: e.target.value as LinkKind })}
          >
            {LINK_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(LINK_KIND_LABEL[k])}
              </option>
            ))}
          </select>
          <label htmlFor={`${baseId}-url-${l.key}`} className="visually-hidden">
            {t('upload.linkUrl', { n: i + 1 })}
          </label>
          <input
            id={`${baseId}-url-${l.key}`}
            type="url"
            placeholder="https://"
            maxLength={2048}
            value={l.url}
            disabled={disabled}
            onChange={(e) => update(l.key, { url: e.target.value })}
          />
          <label htmlFor={`${baseId}-label-${l.key}`} className="visually-hidden">
            {t('upload.linkLabel', { n: i + 1 })}
          </label>
          <input
            id={`${baseId}-label-${l.key}`}
            placeholder={t('upload.linkLabelPlaceholder')}
            maxLength={200}
            value={l.label}
            disabled={disabled}
            onChange={(e) => update(l.key, { label: e.target.value })}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(links.filter((x) => x.key !== l.key))}
            aria-label={t('upload.removeLink', { n: i + 1 })}
          >
            {t('common.remove')}
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled || links.length >= 20}
        onClick={() =>
          onChange([
            ...links,
            { key: Date.now() + links.length, kind: 'intranet', url: '', label: '' },
          ])
        }
      >
        {t('upload.addLink')}
      </button>
    </fieldset>
  );
}
