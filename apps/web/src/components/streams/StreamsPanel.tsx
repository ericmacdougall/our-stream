// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { Stream, StreamKind } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import { t, type MessageId } from '@/lib/i18n';
import { slugify } from '../auth/SignUpForm';
import { Notice } from '../Notice';

type StreamT = z.output<typeof Stream>;
type Kind = z.output<typeof StreamKind>;

export const STREAM_KINDS: Kind[] = ['company', 'department', 'team', 'project', 'private'];
export const KIND_LABEL: Record<Kind, MessageId> = {
  company: 'streams.kind.company',
  department: 'streams.kind.department',
  team: 'streams.kind.team',
  project: 'streams.kind.project',
  private: 'streams.kind.private',
};

export function StreamsPanel({ initial }: { initial: StreamT[] }) {
  const router = useRouter();
  const [streams, setStreams] = useState(initial);
  const [kind, setKind] = useState<Kind>('team');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await browserApi().POST('/v1/streams', { body: { kind, slug, name } });
      const message = errorMessage(result);
      if (message || !result.data) {
        setError(message ?? t('error.generic'));
        return;
      }
      setStreams((s) => [...s, result.data as StreamT]);
      setName('');
      setSlug('');
      setSlugTouched(false);
      router.refresh();
    } catch {
      setError(t('error.network'));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <section aria-labelledby="streams-heading" className="card">
        <h2 id="streams-heading">{t('streams.listHeading')}</h2>
        {streams.length === 0 ? (
          <p className="muted">{t('streams.empty')}</p>
        ) : (
          <ul className="list" data-testid="streams-list">
            {streams.map((s) => (
              <li key={s.id}>
                <Link href={`/streams/${s.id}`}>{s.name}</Link>{' '}
                <span className="muted">
                  {t(KIND_LABEL[s.kind])} · {s.slug}
                  {s.myRole ? ` · ${t('streams.myRole', { role: s.myRole })}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <form onSubmit={(e) => void create(e)} className="card form" noValidate>
        <h2>{t('streams.createHeading')}</h2>
        <div className="field">
          <label htmlFor="stream-kind">{t('streams.kind')}</label>
          <select id="stream-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {STREAM_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="stream-name">{t('streams.name')}</label>
          <input
            id="stream-name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="stream-slug">{t('streams.slug')}</label>
          <input
            id="stream-slug"
            required
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
          />
        </div>
        <Notice kind="error">{error}</Notice>
        <div className="actions">
          <button type="submit" className="primary" disabled={pending}>
            {pending ? t('common.working') : t('streams.create')}
          </button>
        </div>
      </form>
    </>
  );
}
