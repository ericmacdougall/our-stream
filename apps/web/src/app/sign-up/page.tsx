// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import { SignUpForm } from '@/components/auth/SignUpForm';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: `${t('auth.signUp.title')} · ${t('app.name')}` };

export default function SignUpPage() {
  return (
    <main id="main" className="page narrow">
      <SignUpForm />
    </main>
  );
}
