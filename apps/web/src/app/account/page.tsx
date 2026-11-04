// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { SetPasswordForm } from '@/components/account/SetPasswordForm';
import { requireMe } from '@/lib/api/require';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('account.title')} · ${t('app.name')}` };

export default async function AccountPage() {
  const me = await requireMe('/account');
  return (
    <main id="main" className="page narrow">
      <header className="masthead">
        <h1>{t('account.title')}</h1>
        <p className="muted">
          {t('account.signedInAs', { name: me.user.displayName, email: me.user.email })}
        </p>
      </header>
      <SetPasswordForm />
    </main>
  );
}
