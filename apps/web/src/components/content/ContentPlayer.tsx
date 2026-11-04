// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// The content page's player (share-as-link target, /content/{id}?t= deep link) with the same
// reaction row and comments as the feed. Playback starts on an explicit Play (a landing page should
// not autoplay); the player seeks to ?t= once the media reports its duration.
import { useRef, useState } from 'react';
import { formatTimestamp } from '@/lib/feed/chapters';
import { t } from '@/lib/i18n';
import type { M1bItemFields } from '@/lib/m1b/api';
import { useDocumentVisible, usePlaybackEngagement } from '@/lib/m1b/usePlaybackEngagement';
import { CommentsPanel } from '../comments/CommentsPanel';
import { Player, type PlayerHandle } from '../feed/Player';
import { ReactionBar } from '../feed/ReactionBar';
import { ShareDialog } from '../share/ShareDialog';
import { Notice } from '../Notice';

interface Media {
  hls: string;
  poster: string | null;
  captions: { lang: string; url: string }[];
}

export function ContentPlayer({
  contentId,
  versionId,
  durationMs,
  title,
  language,
  media,
  item,
  tMs,
}: {
  contentId: string;
  versionId: string;
  durationMs: number | null;
  title: string;
  language: string;
  media: Media;
  item: M1bItemFields;
  tMs: number | null;
}) {
  const documentVisible = useDocumentVisible();
  const handle = useRef<PlayerHandle | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [commentCount, setCommentCount] = useState(item.commentCount);
  const seeked = useRef(false);
  const playback = usePlaybackEngagement({
    contentId,
    versionId,
    durationMs,
    eligible: documentVisible,
  });
  const start = tMs === null ? null : Math.min(tMs, durationMs ?? tMs);

  if (unavailable) {
    return <Notice kind="error">{t('error.unavailable')}</Notice>;
  }
  return (
    <section className="card" aria-labelledby="content-watch-heading">
      <h2 id="content-watch-heading">{t('content.watch')}</h2>
      <div className="inline-player" data-testid="content-player">
        <Player
          ref={handle}
          src={media.hls}
          poster={media.poster}
          captions={media.captions}
          language={language}
          title={title}
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
            if (!seeked.current && start !== null && ms !== null) {
              seeked.current = true;
              handle.current?.seekToMs(start);
            }
          }}
        />
        <div className="inline-player-controls" role="toolbar" aria-label={t('feed.controls')}>
          <button
            type="button"
            className="primary"
            onClick={() => setPlaying((p) => !p)}
            data-testid="content-play"
          >
            {playing ? t('feed.pause') : t('feed.play')}
          </button>
          <button type="button" onClick={() => setMuted((m) => !m)}>
            {muted ? t('feed.unmute') : t('feed.mute')}
          </button>
          <button type="button" onClick={() => setCaptions((c) => !c)}>
            {captions ? t('feed.captionsOff') : t('feed.captionsOn')}
          </button>
          {start !== null ? (
            <span className="muted" role="status" data-testid="content-start-at">
              {t('search.playingFrom', { title, time: formatTimestamp(start) })}
            </span>
          ) : null}
        </div>
      </div>
      <ReactionBar
        contentId={contentId}
        item={{ ...item, commentCount }}
        commentsOpen={commentsOpen}
        onOpenComments={() => setCommentsOpen((o) => !o)}
        onShare={() => setSharing(true)}
        onUnavailable={() => setUnavailable(true)}
      />
      {commentsOpen ? (
        <CommentsPanel
          contentId={contentId}
          title={title}
          onClose={() => setCommentsOpen(false)}
          onUnavailable={() => setUnavailable(true)}
          onCountDelta={(delta) => setCommentCount((c) => Math.max(0, c + delta))}
        />
      ) : null}
      <ShareDialog
        contentId={sharing ? contentId : null}
        title={title}
        onClose={() => setSharing(false)}
        onUnavailable={() => setUnavailable(true)}
      />
    </section>
  );
}
