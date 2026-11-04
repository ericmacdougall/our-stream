// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// The token is consumed on an explicit press, not on page load, so link-scanning mail gateways
// cannot burn a single-use token before the person arrives.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { browserApi } from '@/lib/api/client';
import { errorMessage } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { Notice } from '../Notice';

export function MagicConsume({ token }: { token: string | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token || token.length < 20) {
    return (
      <div className="card">
        <h1>{t('auth.magic.title')}</h1>
        <Notice kind="error">{t('auth.magic.missing')}</Notice>
        <p>
          <Link href="/sign-in">{t('auth.signIn.link')}</Link>
        </p>
      </div>
    );
  }

  async function consume() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await browserApi().POST('/v1/auth/magic-link/consume', { body: { token } });
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
    <div className="card">
      <h1>{t('auth.magic.title')}</h1>
      <p>{t('auth.magic.intro')}</p>
      <Notice kind="error">{error}</Notice>
      <div className="actions">
        <button type="button" className="primary" onClick={() => void consume()} disabled={pending}>
          {pending ? t('common.working') : t('auth.magic.continue')}
        </button>
      </div>
    </div>
  );
}
