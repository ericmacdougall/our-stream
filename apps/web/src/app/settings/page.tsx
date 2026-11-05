// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { Notice } from '@/components/Notice';
import { OrgSettingsForm } from '@/components/settings/OrgSettingsForm';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('nav.settings')} · ${t('app.name')}` };

export default async function SettingsPage() {
  const me = await requireMe('/settings');
  const canManage = me.org?.role === 'owner' || me.org?.role === 'admin';
  let body: React.ReactNode;
  if (!canManage) {
    body = <Notice kind="error">{t('settings.forbidden')}</Notice>;
  } else {
    const api = await serverApi();
    const { data } = await api.GET('/v1/org/settings');
    body = data ? (
      <OrgSettingsForm initialDocumentsEnabled={data.documentsEnabled} />
    ) : (
      <Notice kind="error">{t('settings.unavailable')}</Notice>
    );
  }
  return (
    <main id="main" className="page">
      <header className="masthead">
        <h1>{t('settings.heading')}</h1>
        <p className="muted">{t('settings.intro')}</p>
      </header>
      {body}
    </main>
  );
}
