// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignUpForm } from '@/components/auth/SignUpForm';
import { getMe } from '@/lib/api/server';
import { signedInDestination } from '@/lib/auth-redirect';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('auth.signUp.title')} · ${t('app.name')}` };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Already signed in: creating a second organisation needs a sign-out first; go home (or to ?next).
  const destination = signedInDestination(await getMe(), params['next']);
  if (destination) redirect(destination);
  return (
    <main id="main" className="page narrow">
      <SignUpForm />
    </main>
  );
}
