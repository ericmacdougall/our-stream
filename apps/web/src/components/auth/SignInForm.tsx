// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { browserApi } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { Notice } from '../Notice';

export function SignInForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<'password' | 'magic' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);

  async function signIn(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending('password');
    setError(null);
    try {
      const result = await browserApi().POST('/v1/auth/login', { body: { email, password } });
      const message = errorMessage(result);
      if (message) {
        setError(message);
        return;
      }
      router.push(nextPath);
      router.refresh();
    } catch {
      setError(t('error.network'));
    } finally {
      setPending(null);
    }
  }

  async function requestMagicLink() {
    if (pending) return;
    if (!email) {
      setError(t('auth.emailRequiredForMagic'));
      return;
    }
    setPending('magic');
    setError(null);
    try {
      // Neutral outcome whatever the server says: never reveal whether the address exists.
      await browserApi().POST('/v1/auth/magic-link', { body: { email } });
    } catch {
      // Same neutral copy on network failure.
    } finally {
      setMagicSent(true);
      setPending(null);
    }
  }

  return (
    <form onSubmit={(e) => void signIn(e)} className="card form" noValidate>
      <h1>{t('auth.signIn.title')}</h1>
      <div className="field">
        <label htmlFor="email">{t('auth.email')}</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Notice kind="error">{error}</Notice>
      {magicSent ? <Notice kind="success">{t('auth.magicSent')}</Notice> : null}
      <div className="actions">
        <button type="submit" className="primary" disabled={pending !== null}>
          {pending === 'password' ? t('common.working') : t('auth.signIn.submit')}
        </button>
        <button type="button" onClick={() => void requestMagicLink()} disabled={pending !== null}>
          {pending === 'magic' ? t('common.working') : t('auth.magicRequest')}
        </button>
      </div>
      <p className="muted">
        {t('auth.noAccount')} <Link href="/sign-up">{t('auth.signUp.link')}</Link>
      </p>
    </form>
  );
}
