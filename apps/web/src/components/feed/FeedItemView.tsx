// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { forwardRef, useRef, useState } from 'react';
import type { z } from 'zod';
import type { FeedItemM1b } from '@our-stream/contracts';
import { activeChapterIndex, formatTimestamp } from '@/lib/feed/chapters';
import { externalHost } from '@/lib/links';
import type { FeedSettings } from '@/lib/feed/settings';
import { t } from '@/lib/i18n';
import { useDocumentVisible, usePlaybackEngagement } from '@/lib/m1b/usePlaybackEngagement';
import { Player, type PlayerHandle } from './Player';
import { ReactionBar } from './ReactionBar';

type Item = z.output<typeof FeedItemM1b>;

export interface FeedItemViewProps {
  item: Item;
  index: number;
  active: boolean;
  warm: boolean;
  shouldPlay: boolean;
  settings: FeedSettings;
  reducedMotion: boolean;
  commentsOpen: boolean;
  onEnded: () => void;
  onTogglePlay: () => void;
  onExternalLink: (url: string, label: string) => void;
  onError: () => void;
  onOpenComments: () => void;
  onShare: () => void;
  onUnavailable: () => void;
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
    commentsOpen,
    onEnded,
    onTogglePlay,
    onExternalLink,
    onError,
    onOpenComments,
    onShare,
    onUnavailable,
  },
  ref,
) {
  const [timeMs, setTimeMs] = useState(0);
  // Kept in a ref, not state: a ref callback that sets state re-runs on every commit.
  const handleRef = useRef<PlayerHandle | null>(null);
  const chapterIndex = activeChapterIndex(item.chapters, timeMs);
  // Engagement and the view record count only for the active item in a visible tab.
  const documentVisible = useDocumentVisible();
  const playback = usePlaybackEngagement({
    contentId: item.id,
    versionId: item.versionId,
    durationMs: item.durationMs,
    eligible: active && documentVisible,
  });
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
          onPlaying={playback.onPlaying}
          onPause={playback.onPause}
          onEnded={() => {
            playback.onEnded();
            onEnded();
          }}
          onTimeMs={(ms) => {
            setTimeMs(ms);
            playback.onTimeMs(ms);
          }}
          onSeeked={playback.onSeeked}
          onDurationMs={playback.onDurationMs}
          onError={onError}
        />
        {/* The overlay's visible text is its accessible name (WCAG 2.5.3): no aria-label override. */}
        {active && !shouldPlay ? (
          <button type="button" className="play-overlay" onClick={onTogglePlay}>
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
        <ReactionBar
          contentId={item.id}
          item={item}
          commentsOpen={commentsOpen}
          onOpenComments={onOpenComments}
          onShare={onShare}
          onUnavailable={onUnavailable}
        />
        {item.description || item.chapters.length > 0 || item.links.length > 0 ? (
          // The only scrollable part of the meta block; the action row above it is never clipped.
          // Focusable so keyboard users can scroll it (axe: scrollable-region-focusable).
          <div
            className="feed-extra"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users must be able to scroll this region
            tabIndex={0}
            role="region"
            aria-label={t('feed.moreAbout')}
          >
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
                    {externalHost(l.url) === null ? (
                      // Not http(s): never render as a clickable link (javascript:, data:, ...).
                      <span>{l.label || t('feed.linkUnavailable')}</span>
                    ) : l.kind === 'internet' ? (
                      <a
                        href={l.url}
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.preventDefault();
                          onExternalLink(l.url, l.label || l.url);
                        }}
                      >
                        {l.label || l.url}{' '}
                        <span className="muted">({t('links.kind.internet')})</span>
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
        ) : null}
      </div>
    </article>
  );
});
