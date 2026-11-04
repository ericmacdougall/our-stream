// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { MagicConsume } from '@/components/auth/MagicConsume';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('auth.magic.title')} · ${t('app.name')}` };

export default async function MagicPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params['token'];
  const token = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  return (
    <main id="main" className="page narrow">
      <MagicConsume token={token} />
    </main>
  );
}
