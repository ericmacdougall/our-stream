// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { SignInForm } from '@/components/auth/SignInForm';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('auth.signIn.title')} · ${t('app.name')}` };

function safeNext(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  // Same-origin paths only: never bounce to another site after sign-in.
  return v && v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

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
