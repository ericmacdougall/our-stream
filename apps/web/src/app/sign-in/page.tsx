// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { SignInForm } from '@/components/auth/SignInForm';
import { t } from '@/lib/i18n';
import { safeNext } from '@/lib/safe-next';

export const metadata: Metadata = { title: `${t('auth.signIn.title')} · ${t('app.name')}` };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <main id="main" className="page narrow">
      <SignInForm nextPath={safeNext(params['next'])} />
    </main>
  );
}
