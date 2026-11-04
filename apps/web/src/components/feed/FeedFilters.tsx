// SPDX-License-Identifier: AGPL-3.0-only
// Feed filters (M1b): department/team stream, event tag, pinned only. A plain GET form keeps the
// choice in the URL; the server applies the filters inside readerVisible, so they can only narrow.
import { t } from '@/lib/i18n';
import { TAGS, type Tag } from '@/lib/m1b/search';
import { TAG_LABEL } from '@/lib/m1b/tags';

export function FeedFilters({
  streams,
  streamId,
  tag,
  pinned,
}: {
  streams: { id: string; name: string }[];
  streamId?: string;
  tag?: Tag;
  pinned: boolean;
}) {
  const active = Boolean(streamId || tag || pinned);
  return (
    <form action="/" method="get" className="feed-filters" aria-label={t('filters.label')}>
      <label htmlFor="filter-stream">{t('filters.stream')}</label>
      <select id="filter-stream" name="streamId" defaultValue={streamId ?? ''}>
        <option value="">{t('filters.anyStream')}</option>
        {streams.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <label htmlFor="filter-tag">{t('filters.tag')}</label>
      <select id="filter-tag" name="tag" defaultValue={tag ?? ''}>
        <option value="">{t('filters.anyTag')}</option>
        {TAGS.map((value) => (
          <option key={value} value={value}>
            {t(TAG_LABEL[value])}
          </option>
        ))}
      </select>
      <label className="inline">
        <input type="checkbox" name="pinned" value="true" defaultChecked={pinned} />{' '}
        {t('filters.pinned')}
      </label>
      <button type="submit">{t('filters.apply')}</button>
      {active ? (
        <a href="/" className="button">
          {t('filters.clear')}
        </a>
      ) : null}
    </form>
  );
}
