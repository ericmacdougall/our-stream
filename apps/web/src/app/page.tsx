// SPDX-License-Identifier: AGPL-3.0-only
// M0 landing: proves the web app renders, reaches the API through the shared contract, and shows the
// AGPL §13 source link. The feed arrives with M1a.
import { createClient } from '@our-stream/contracts';
import { t } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

async function fetchMeta() {
  const baseUrl =
    process.env['API_INTERNAL_URL'] ??
    process.env['NEXT_PUBLIC_API_URL'] ??
    'http://localhost:4000';
  try {
    const client = createClient({ baseUrl });
    const { data } = await client.GET('/v1/meta');
    return data ?? null;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const meta = await fetchMeta();
  return (
    <main id="main" className="page">
      <header className="masthead">
        <h1>{t('app.name')}</h1>
        <p className="muted">{t('app.tagline')}</p>
      </header>
      <section aria-labelledby="status-heading" className="card">
        <h2 id="status-heading">{t('status.heading')}</h2>
        {meta ? (
          <p>
            {t('status.apiReachable', { version: meta.version })}{' '}
            <a href={meta.sourceUrl} rel="noreferrer">
              {t('status.sourceLink')}
            </a>
          </p>
        ) : (
          <p role="status">{t('status.apiUnreachable')}</p>
        )}
      </section>
      <footer className="footer">
        <a
          href={meta?.sourceUrl ?? 'https://github.com/ericmacdougall/our-stream'}
          rel="noreferrer"
        >
          {t('footer.source')}
        </a>
      </footer>
    </main>
  );
}
