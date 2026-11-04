// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { forwardRef, useRef, useState } from 'react';
import type { z } from 'zod';
import type { FeedItem } from '@our-stream/contracts';
import { activeChapterIndex, formatTimestamp } from '@/lib/feed/chapters';
import type { FeedSettings } from '@/lib/feed/settings';
import { t } from '@/lib/i18n';
import { Player, type PlayerHandle } from './Player';

type Item = z.output<typeof FeedItem>;

export interface FeedItemViewProps {
  item: Item;
  index: number;
  active: boolean;
  warm: boolean;
  shouldPlay: boolean;
  settings: FeedSettings;
  reducedMotion: boolean;
  onPlaying: () => void;
  onEnded: () => void;
  onTogglePlay: () => void;
  onExternalLink: (url: string, label: string) => void;
  onError: () => void;
}

export const FeedItemView = forwardRef<HTMLElement, FeedItemViewProps>(function FeedItemView(
  {
    item,
    index,
    active,
    warm,
    shouldPlay,
    settings,
    reducedMotion,
    onPlaying,
    onEnded,
    onTogglePlay,
    onExternalLink,
    onError,
  },
  ref,
) {
  const [timeMs, setTimeMs] = useState(0);
  // Kept in a ref, not state: a ref callback that sets state re-runs on every commit.
  const handleRef = useRef<PlayerHandle | null>(null);
  const chapterIndex = activeChapterIndex(item.chapters, timeMs);
  const headingId = `feed-item-${item.id}-title`;

  return (
    <article
      ref={ref}
      className="feed-item"
      data-testid="feed-item"
      data-content-id={item.id}
      data-active={active ? 'true' : 'false'}
      data-index={index}
      aria-labelledby={headingId}
      aria-current={active ? 'true' : undefined}
      tabIndex={-1}
    >
      <div className="feed-media">
        <Player
          ref={handleRef}
          src={item.media.hls}
          poster={item.media.poster}
          captions={item.media.captions}
          language={item.language}
          title={item.title}
          warm={warm}
          shouldPlay={shouldPlay}
          muted={settings.muted}
          showCaptions={settings.captions}
          onPlaying={onPlaying}
          onEnded={onEnded}
          onTimeMs={setTimeMs}
          onError={onError}
        />
        {active && !shouldPlay ? (
          <button
            type="button"
            className="play-overlay"
            onClick={onTogglePlay}
            aria-label={t('feed.play')}
          >
            {reducedMotion ? t('feed.playReducedMotion') : t('feed.play')}
          </button>
        ) : null}
      </div>
      <div className="feed-meta">
        <h2 id={headingId} className="feed-title">
          <Link href={`/content/${item.id}`}>{item.title}</Link>
        </h2>
        <p className="muted feed-byline">
          <span>{t('feed.byOwner', { name: item.owner.displayName })}</span>
          {item.streams.map((s) => (
            <span key={s.id} className="chip">
              {s.name}
            </span>
          ))}
          {item.viewed ? (
            <span className="chip viewed" data-testid="viewed-badge">
              {t('feed.viewed')}
            </span>
          ) : null}
        </p>
        {item.description ? <p className="feed-description">{item.description}</p> : null}
        {item.chapters.length > 0 ? (
          <nav aria-label={t('upload.chapters')} className="chapters">
            <ol>
              {item.chapters.map((c, i) => (
                <li key={c.atMs}>
                  <button
                    type="button"
                    className={i === chapterIndex ? 'chapter current' : 'chapter'}
                    aria-current={i === chapterIndex ? 'true' : undefined}
                    onClick={() => {
                      handleRef.current?.seekToMs(c.atMs);
                      void handleRef.current?.play();
                    }}
                  >
                    <span className="time">{formatTimestamp(c.atMs)}</span> {c.title}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        {item.links.length > 0 ? (
          <ul className="feed-links" aria-label={t('upload.links')}>
            {item.links.map((l) => (
              <li key={l.url}>
                {l.kind === 'internet' ? (
                  <a
                    href={l.url}
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      e.preventDefault();
                      onExternalLink(l.url, l.label || l.url);
                    }}
                  >
                    {l.label || l.url} <span className="muted">({t('links.kind.internet')})</span>
                  </a>
                ) : (
                  <a href={l.url} rel="noopener noreferrer">
                    {l.label || l.url}
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
});
