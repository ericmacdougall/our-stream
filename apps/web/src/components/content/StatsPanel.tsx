// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Per-clip engagement for the author (ADR-0006, decision Q1). Counts always; the viewer table only
// when the server sends `viewers` (org privacy mode `named`). The client never infers names from
// anything else.
import { useCallback, useEffect, useState } from 'react';
import { t, type MessageId } from '@/lib/i18n';
import { contentStats, type Stats } from '@/lib/m1b/api';
import { Notice } from '../Notice';

const INTRO: Record<Stats['privacyMode'], MessageId> = {
  aggregate_only: 'stats.intro.aggregate_only',
  identified_for_required_only: 'stats.intro.identified_for_required_only',
  named: 'stats.intro.named',
};

export function StatsPanel({ contentId }: { contentId: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await contentStats(contentId);
    if (result.ok) setStats(result.data);
    else setError(result.message);
    setLoading(false);
  }, [contentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const when = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(iso),
        )
      : '';

  return (
    <section className="card" aria-labelledby="stats-heading" data-testid="stats-panel">
      <h2 id="stats-heading">{t('stats.heading')}</h2>
      {loading ? <p className="muted">{t('common.loading')}</p> : null}
      <Notice kind="error">{error}</Notice>
      {stats ? (
        <>
          <p className="muted" data-testid="stats-privacy" data-mode={stats.privacyMode}>
            {t(INTRO[stats.privacyMode])}
          </p>
          <dl className="meta stats-grid">
            <dt>{t('stats.uniqueViewers')}</dt>
            <dd data-testid="stat-unique">{stats.uniqueViewers}</dd>
            <dt>{t('stats.viewStarts')}</dt>
            <dd data-testid="stat-views">{stats.viewStarts}</dd>
            <dt>{t('stats.completions')}</dt>
            <dd data-testid="stat-completions">{stats.completions}</dd>
            <dt>{t('stats.rewatches')}</dt>
            <dd data-testid="stat-rewatches">{stats.rewatches}</dd>
            <dt>{t('stats.milestones')}</dt>
            <dd data-testid="stat-milestones">
              {stats.milestones.p25} / {stats.milestones.p50} / {stats.milestones.p75}
            </dd>
            <dt>{t('stats.likes')}</dt>
            <dd>{stats.likes}</dd>
            <dt>{t('stats.comments')}</dt>
            <dd>{stats.comments}</dd>
          </dl>
          {stats.viewers ? (
            <table className="viewers" data-testid="viewers-table">
              <caption>{t('stats.viewers')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('stats.viewer')}</th>
                  <th scope="col">{t('stats.firstViewed')}</th>
                  <th scope="col">{t('stats.lastViewed')}</th>
                  <th scope="col">{t('stats.maxProgress')}</th>
                  <th scope="col">{t('stats.completed')}</th>
                  <th scope="col">{t('stats.watchCount')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.viewers.map((v) => (
                  <tr key={v.userId}>
                    <th scope="row">{v.displayName}</th>
                    <td>{when(v.firstViewedAt)}</td>
                    <td>{when(v.lastViewedAt)}</td>
                    <td>{v.maxProgressPct} %</td>
                    <td>{v.completed ? t('stats.yes') : t('stats.no')}</td>
                    <td>{v.watchCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div className="actions">
            <button type="button" onClick={() => void load()} disabled={loading}>
              {t('stats.refresh')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
