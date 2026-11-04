// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// One clip's <video>. HLS through hls.js (MSE) or the native player on Safari without MSE; a
// progressive source when the URL is not a playlist. Media URLs must be relative /media paths
// (ADR-0003): the same-origin rewrite carries the session cookie, nothing else is accepted.
import type Hls from 'hls.js';
import { forwardRef, useEffect, useImperativeHandle, useRef, type SyntheticEvent } from 'react';
import { isHlsUrl, isSafeMediaPath } from '@/lib/links';
import { t } from '@/lib/i18n';

export interface PlayerHandle {
  seekToMs(ms: number): void;
  play(): Promise<void>;
  pause(): void;
  readonly element: HTMLVideoElement | null;
}

export interface PlayerProps {
  src: string;
  poster: string | null;
  captions: { lang: string; url: string }[];
  language: string;
  title: string;
  /** Attach media and buffer when true (active item or its neighbours). */
  warm: boolean;
  /** Play when true, pause when false. */
  shouldPlay: boolean;
  muted: boolean;
  showCaptions: boolean;
  onPlaying?: () => void;
  onEnded?: () => void;
  onTimeMs?: (ms: number) => void;
  onError?: () => void;
}

function preferNativeHls(video: HTMLVideoElement): boolean {
  const w = window as Window & { ManagedMediaSource?: unknown };
  const hasMse =
    typeof window.MediaSource !== 'undefined' || typeof w.ManagedMediaSource !== 'undefined';
  return video.canPlayType('application/vnd.apple.mpegurl') !== '' && !hasMse;
}

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(props, ref) {
  const {
    src,
    poster,
    captions,
    language,
    title,
    warm,
    shouldPlay,
    muted,
    showCaptions,
    onPlaying,
    onEnded,
    onTimeMs,
    onError,
  } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const attachedRef = useRef<string | null>(null);
  const safe = isSafeMediaPath(src);

  useImperativeHandle(
    ref,
    () => ({
      seekToMs(ms) {
        const v = videoRef.current;
        if (v) v.currentTime = ms / 1000;
      },
      async play() {
        const v = videoRef.current;
        if (!v) return;
        try {
          await v.play();
        } catch {
          // Autoplay blocked or interrupted by a source change: the persistent control remains.
        }
      },
      pause() {
        videoRef.current?.pause();
      },
      get element() {
        return videoRef.current;
      },
    }),
    [],
  );

  // Attach / detach the media source.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !safe) return;
    if (!warm) {
      if (attachedRef.current) {
        hlsRef.current?.destroy();
        hlsRef.current = null;
        video.removeAttribute('src');
        video.load();
        attachedRef.current = null;
      }
      return;
    }
    if (attachedRef.current === src) return;
    attachedRef.current = src;
    let cancelled = false;

    async function attach() {
      if (!video) return;
      if (!isHlsUrl(src) || preferNativeHls(video)) {
        video.src = src;
        return;
      }
      const { default: HlsCtor } = await import('hls.js');
      if (cancelled) return;
      if (!HlsCtor.isSupported()) {
        video.src = src;
        return;
      }
      const hls = new HlsCtor({
        // Captions come from <track> elements fed by the contract, not from the playlist.
        enableWebVTT: false,
        enableIMSC1: false,
        enableCEA708Captions: false,
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      hlsRef.current = hls;
      hls.on(HlsCtor.Events.ERROR, (_e, data) => {
        if (data.fatal) onError?.();
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    }
    void attach();
    return () => {
      cancelled = true;
    };
  }, [src, warm, safe, onError]);

  useEffect(
    () => () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    },
    [],
  );

  // Play / pause follows the feed's decision.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !warm) return;
    if (shouldPlay) {
      video.play().catch(() => {
        // Blocked autoplay: the viewer can press the persistent play control.
      });
    } else {
      video.pause();
    }
  }, [shouldPlay, warm, src]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = muted;
  }, [muted]);

  // Caption visibility.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      if (!track) continue;
      const preferred = track.language === language || i === 0;
      track.mode = showCaptions && preferred ? 'showing' : 'hidden';
    }
  }, [showCaptions, language, captions]);

  if (!safe) {
    return (
      <div className="player player-error" role="img" aria-label={title}>
        <p>{t('feed.mediaUnavailable')}</p>
      </div>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- <track> children come from media.captions below
    <video
      ref={videoRef}
      className="player"
      data-testid="feed-video"
      playsInline
      muted={muted}
      preload={warm ? 'auto' : 'none'}
      poster={poster && isSafeMediaPath(poster) ? poster : undefined}
      aria-label={title}
      crossOrigin="use-credentials"
      onPlaying={onPlaying}
      onEnded={onEnded}
      onError={onError}
      onTimeUpdate={(e: SyntheticEvent<HTMLVideoElement>) =>
        onTimeMs?.(Math.floor(e.currentTarget.currentTime * 1000))
      }
    >
      {captions
        .filter((c) => isSafeMediaPath(c.url))
        .map((c, i) => (
          <track
            key={c.url}
            kind="subtitles"
            src={c.url}
            srcLang={c.lang}
            label={c.lang}
            default={showCaptions && (c.lang === language || i === 0)}
          />
        ))}
    </video>
  );
});
