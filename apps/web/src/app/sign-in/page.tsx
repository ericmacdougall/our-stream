// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignInForm } from '@/components/auth/SignInForm';
import { getMe } from '@/lib/api/server';
import { signedInDestination } from '@/lib/auth-redirect';
import { t } from '@/lib/i18n';
import { safeNext } from '@/lib/safe-next';

export const metadata: Metadata = { title: `${t('auth.signIn.title')} · ${t('app.name')}` };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Server-side session check (the proxy only sees cookie presence): someone already signed in goes
  // where they were headed; a stale cookie makes getMe null and simply renders the form.
  const destination = signedInDestination(await getMe(), params['next']);
  if (destination) redirect(destination);
  return (
    <main id="main" className="page narrow">
      <SignInForm nextPath={safeNext(params['next'])} />
    </main>
  );
}
