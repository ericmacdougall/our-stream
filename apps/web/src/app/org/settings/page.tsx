// SPDX-License-Identifier: AGPL-3.0-only
// Organisation settings for owners and admins. Members get a neutral refusal (the API refuses the
// PATCH anyway); the page never renders another member's data.
import type { Metadata } from 'next';
import { OrgSettingsForm } from '@/components/org/OrgSettingsForm';
import { Notice } from '@/components/Notice';
import { requireMe } from '@/lib/api/require';
import { serverApi } from '@/lib/api/server';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('org.title')} · ${t('app.name')}` };

export default async function OrgSettingsPage() {
  const me = await requireMe('/org/settings');
  const role = me.org?.role;
  const allowed = role === 'owner' || role === 'admin';
  const api = await serverApi();
  const { data } = allowed ? await api.GET('/v1/org/settings') : { data: undefined };
  return (
    <main id="main" className="page narrow">
      <header className="masthead">
        <h1>{t('org.title')}</h1>
      </header>
      {!allowed ? (
        <Notice kind="error">{t('org.forbidden')}</Notice>
      ) : data ? (
        <OrgSettingsForm initial={data} />
      ) : (
        <Notice kind="error">{t('error.generic')}</Notice>
      )}
    </main>
  );
}
