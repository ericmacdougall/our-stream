// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Search results with counts, highlighted snippets and timestamp deep links. The form is a plain
// GET so the query stays in the URL; opening a transcript hit updates ?play=&t= (shareable) and
// shows an inline player seeked to that instant. Under reduced motion the player waits for Play.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTimestamp } from '@/lib/feed/chapters';
import { t, type MessageId } from '@/lib/i18n';
import { search, withM1bDefaults, type Search as SearchPage, type Tag } from '@/lib/m1b/api';
import { formatTotal, searchHref, snippetSegments, TAGS, type SearchState } from '@/lib/m1b/search';
import { useDocumentVisible, usePlaybackEngagement } from '@/lib/m1b/usePlaybackEngagement';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { TAG_LABEL } from '@/lib/m1b/tags';
import { Player, type PlayerHandle } from '../feed/Player';
import { Notice } from '../Notice';

type Hit = SearchPage['items'][number];
type Status = 'idle' | 'loading' | 'ready' | 'error';

const SOURCE_LABEL: Record<Hit['snippets'][number]['source'], MessageId> = {
  title: 'search.source.title',
  description: 'search.source.description',
  transcript: 'search.source.transcript',
};

function InlinePlayer({ hit, tMs, onClose }: { hit: Hit; tMs: number; onClose: () => void }) {
  const reducedMotion = useReducedMotion();
  const documentVisible = useDocumentVisible();
  const handle = useRef<PlayerHandle | null>(null);
  const [playing, setPlaying] = useState(!reducedMotion);
  const [muted, setMuted] = useState(true);
  const [captions, setCaptions] = useState(true);
  const seeked = useRef(false);
  const playback = usePlaybackEngagement({
    contentId: hit.id,
    versionId: hit.versionId,
    durationMs: hit.durationMs,
    eligible: documentVisible,
  });
  const start = Math.min(tMs, hit.durationMs ?? tMs);
  const headingId = `inline-player-${hit.id}`;
  return (
    <div
      className="inline-player"
      role="region"
      aria-labelledby={headingId}
      data-testid="inline-player"
    >
      <h3 id={headingId} className="visually-hidden">
        {t('search.playerLabel', { title: hit.title })}
      </h3>
      <Player
        ref={handle}
        src={hit.media.hls}
        poster={hit.media.poster}
        captions={hit.media.captions}
        language="en"
        title={hit.title}
        warm
        shouldPlay={playing}
        muted={muted}
        showCaptions={captions}
        onPlaying={playback.onPlaying}
        onPause={playback.onPause}
        onEnded={() => {
          playback.onEnded();
          setPlaying(false);
        }}
        onTimeMs={playback.onTimeMs}
        onSeeked={playback.onSeeked}
        onDurationMs={(ms) => {
          playback.onDurationMs(ms);
          // Seek once the media knows its duration; the engagement tracker sees it as a seek.
          if (!seeked.current && ms !== null) {
            seeked.current = true;
            handle.current?.seekToMs(start);
          }
        }}
      />
      <div className="inline-player-controls" role="toolbar" aria-label={t('feed.controls')}>
        <button type="button" onClick={() => setPlaying((p) => !p)} data-testid="inline-play">
          {playing ? t('feed.pause') : reducedMotion ? t('feed.playReducedMotion') : t('feed.play')}
        </button>
        <button type="button" onClick={() => setMuted((m) => !m)}>
          {muted ? t('feed.unmute') : t('feed.mute')}
        </button>
        <button type="button" onClick={() => setCaptions((c) => !c)}>
          {captions ? t('feed.captionsOff') : t('feed.captionsOn')}
        </button>
        <button type="button" onClick={onClose}>
          {t('search.closePlayer')}
        </button>
        <span className="visually-hidden" role="status">
          {t('search.playingFrom', { title: hit.title, time: formatTimestamp(start) })}
        </span>
      </div>
    </div>
  );
}

export function SearchResults({
  initial,
  streams,
}: {
  initial: SearchState;
  streams: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initial.q ? 'loading' : 'idle');
  const [items, setItems] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ id: string; tMs: number } | null>(
    initial.play ? { id: initial.play, tMs: initial.tMs ?? 0 } : null,
  );
  const generation = useRef(0);
  const { q, streamId, tag } = initial;

  const load = useCallback(
    async (cursor?: string) => {
      if (!q) {
        setItems([]);
        setTotal(0);
        setNextCursor(null);
        setStatus('idle');
        return;
      }
      const gen = cursor ? generation.current : ++generation.current;
      setStatus('loading');
      setError(null);
      const input: { q: string; cursor?: string; streamId?: string; tag?: Tag } = { q };
      if (cursor) input.cursor = cursor;
      if (streamId) input.streamId = streamId;
      if (tag) input.tag = tag;
      const result = await search(input);
      if (gen !== generation.current) return;
      if (!result.ok) {
        setStatus('error');
        setError(result.message);
        return;
      }
      const page = result.data.items.map((hit) => ({ ...hit, ...withM1bDefaults(hit) }));
      setItems((prev) => {
        if (!cursor) return page;
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...page.filter((i) => !seen.has(i.id))];
      });
      setTotal(result.data.total);
      setNextCursor(result.data.nextCursor);
      setStatus('ready');
    },
    [q, streamId, tag],
  );

  useEffect(() => {
    void load();
  }, [load]);

  function open(hit: Hit, tMs: number) {
    setPlaying({ id: hit.id, tMs });
    const next: SearchState = { q, play: hit.id, tMs };
    if (streamId) next.streamId = streamId;
    if (tag) next.tag = tag;
    router.replace(searchHref(next), { scroll: false });
  }
  function close() {
    setPlaying(null);
    const next: SearchState = { q };
    if (streamId) next.streamId = streamId;
    if (tag) next.tag = tag;
    router.replace(searchHref(next), { scroll: false });
  }

  const deepLinkMissing =
    status === 'ready' && playing !== null && !items.some((i) => i.id === playing.id);

  return (
    <>
      <form action="/search" method="get" className="card form search-form" role="search">
        <div className="field grow">
          <label htmlFor="q">{t('search.q')}</label>
          <input
            id="q"
            name="q"
            type="search"
            maxLength={200}
            defaultValue={q}
            aria-describedby="q-hint"
            autoComplete="off"
          />
          <small id="q-hint" className="muted">
            {t('search.hint')}
          </small>
        </div>
        <div className="field">
          <label htmlFor="streamId">{t('search.stream')}</label>
          <select id="streamId" name="streamId" defaultValue={streamId ?? ''}>
            <option value="">{t('search.anyStream')}</option>
            {streams.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tag">{t('search.tag')}</label>
          <select id="tag" name="tag" defaultValue={tag ?? ''}>
            <option value="">{t('search.anyTag')}</option>
            {TAGS.map((value) => (
              <option key={value} value={value}>
                {t(TAG_LABEL[value])}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <button type="submit" className="primary">
            {t('search.submit')}
          </button>
        </div>
      </form>

      {status === 'idle' ? <p className="muted">{t('search.prompt')}</p> : null}
      {status === 'loading' ? (
        <p className="muted" role="status">
          {t('common.loading')}
        </p>
      ) : null}
      <Notice kind="error">{error}</Notice>
      {status === 'ready' ? (
        <p role="status" data-testid="search-total">
          {total >= 1000
            ? t('search.totalCapped', { cap: formatTotal(total).replace('+', '') })
            : t('search.total', { total })}
        </p>
      ) : null}
      {deepLinkMissing && playing ? (
        <Notice>
          {t('search.deepLinkMissing')}{' '}
          <Link href={`/content/${playing.id}${playing.tMs ? `?t=${playing.tMs}` : ''}`}>
            {t('search.open')}
          </Link>
        </Notice>
      ) : null}
      {status === 'ready' && items.length === 0 ? (
        <p className="muted">{t('search.empty')}</p>
      ) : null}
      <ol className="search-results">
        {items.map((hit) => (
          <li key={hit.id} className="search-hit" data-testid="search-hit" data-content-id={hit.id}>
            <h2>
              <Link href={`/content/${hit.id}`}>{hit.title}</Link>
            </h2>
            <p className="muted feed-byline">
              <span>{t('feed.byOwner', { name: hit.owner.displayName })}</span>
              {hit.streams.map((s) => (
                <span key={s.id} className="chip">
                  {s.name}
                </span>
              ))}
              {hit.tags.map((value) => (
                <span key={value} className="chip tag">
                  {t(TAG_LABEL[value])}
                </span>
              ))}
            </p>
            {hit.snippets.map((snippet, i) => (
              <p key={i} className="snippet" data-testid="snippet" data-source={snippet.source}>
                <span className="source muted">{t(SOURCE_LABEL[snippet.source])}:</span>
                {snippetSegments(snippet.text, snippet.ranges).map((seg, j) =>
                  seg.mark ? <mark key={j}>{seg.text}</mark> : <span key={j}>{seg.text}</span>,
                )}{' '}
                {snippet.tMs !== null ? (
                  <button
                    type="button"
                    className="chapter"
                    onClick={() => open(hit, snippet.tMs ?? 0)}
                    data-testid="play-from"
                    data-t={snippet.tMs}
                  >
                    {t('search.playFrom', { time: formatTimestamp(snippet.tMs) })}
                  </button>
                ) : null}
              </p>
            ))}
            {playing?.id !== hit.id ? (
              <button type="button" onClick={() => open(hit, 0)} data-testid="play-hit">
                {t('search.play')}
              </button>
            ) : (
              <InlinePlayer
                key={`${hit.id}:${playing.tMs}`}
                hit={hit}
                tMs={playing.tMs}
                onClose={close}
              />
            )}
          </li>
        ))}
      </ol>
      {nextCursor ? (
        <button type="button" onClick={() => void load(nextCursor)} disabled={status === 'loading'}>
          {t('search.more')}
        </button>
      ) : null}
    </>
  );
}
