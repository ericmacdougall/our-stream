// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { browserApi } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import { t, type MessageId } from '@/lib/i18n';
import { PASSWORD_MIN, passwordStrength } from '@/lib/password';
import { Notice } from '../Notice';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

const STRENGTH_KEY: Record<ReturnType<typeof passwordStrength>, MessageId> = {
  tooShort: 'auth.password.tooShort',
  weak: 'auth.password.weak',
  fair: 'auth.password.fair',
  strong: 'auth.password.strong',
};

export function SignUpForm() {
  const router = useRouter();
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = passwordStrength(password);
  const slugValid = orgSlug.length >= 2 && orgSlug.length <= 48 && SLUG_RE.test(orgSlug);

  function onOrgName(value: string) {
    setOrgName(value);
    if (!slugTouched) setOrgSlug(slugify(value));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!slugValid) {
      setError(t('auth.slugInvalid'));
      return;
    }
    if (strength === 'tooShort') {
      setError(t('auth.password.tooShort', { min: PASSWORD_MIN }));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await browserApi().POST('/v1/auth/signup', {
        body: { orgName, orgSlug, displayName, email, password },
      });
      const message = errorMessage(result);
      if (message) {
        setError(message);
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setError(t('error.network'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="card form" noValidate>
      <h1>{t('auth.signUp.title')}</h1>
      <p className="muted">{t('auth.signUp.intro')}</p>
      <div className="field">
        <label htmlFor="orgName">{t('auth.orgName')}</label>
        <input
          id="orgName"
          name="orgName"
          required
          minLength={2}
          maxLength={120}
          autoComplete="organization"
          value={orgName}
          onChange={(e) => onOrgName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="orgSlug">{t('auth.orgSlug')}</label>
        <input
          id="orgSlug"
          name="orgSlug"
          required
          pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
          aria-describedby="orgSlug-hint"
          aria-invalid={orgSlug !== '' && !slugValid}
          value={orgSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setOrgSlug(e.target.value.toLowerCase());
          }}
        />
        <small id="orgSlug-hint" className="muted">
          {t('auth.orgSlugHint')}
        </small>
      </div>
      <div className="field">
        <label htmlFor="displayName">{t('auth.displayName')}</label>
        <input
          id="displayName"
          name="displayName"
          required
          maxLength={120}
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="email">{t('auth.email')}</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="password">{t('auth.password')}</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={PASSWORD_MIN}
          autoComplete="new-password"
          aria-describedby="password-hint"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <small id="password-hint" className="muted" aria-live="polite">
          {password === ''
            ? t('auth.password.hint', { min: PASSWORD_MIN })
            : t(STRENGTH_KEY[strength], { min: PASSWORD_MIN })}
        </small>
      </div>
      <Notice kind="error">{error}</Notice>
      <div className="actions">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? t('common.working') : t('auth.signUp.submit')}
        </button>
      </div>
      <p className="muted">
        {t('auth.haveAccount')} <Link href="/sign-in">{t('auth.signIn.link')}</Link>
      </p>
    </form>
  );
}
