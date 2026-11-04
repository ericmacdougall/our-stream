// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { PreferencesForm } from '@/components/account/PreferencesForm';
import { SetPasswordForm } from '@/components/account/SetPasswordForm';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';
import { t } from '@/lib/i18n';
import { hasPassword } from '@/lib/m1b/api';

export const metadata: Metadata = { title: `${t('account.title')} · ${t('app.name')}` };

export default async function AccountPage() {
  const me = await requireMe('/account');
  const api = await serverApi();
  const { data: preferences } = await api.GET('/v1/me/preferences');
  // MeM1b.hasPassword hides the one-time form for password accounts; an M1a server has no flag and
  // the form stays (its 409 is a settled outcome).
  const showSetPassword = hasPassword(me) !== true;
  return (
    <main id="main" className="page narrow">
      <header className="masthead">
        <h1>{t('account.title')}</h1>
        <p className="muted">
          {t('account.signedInAs', { name: me.user.displayName, email: me.user.email })}
        </p>
      </header>
      <PreferencesForm initial={preferences ?? null} />
      {showSetPassword ? <SetPasswordForm /> : null}
    </main>
  );
}
