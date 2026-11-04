// SPDX-License-Identifier: Apache-2.0
// HLS player over the authenticated media proxy (ADR-0003). The short-lived media token is fetched
// when playback starts, refreshed (source replaced, position restored) when it is near expiry or
// after a playback error, and never logged. Engagement milestones go through the tracker so each
// is sent once per playback session (ADR-0006).
import { useEvent, useEventListener } from 'expo';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { strings } from '../i18n';
import {
  classifyEngagementFailure,
  dueMilestones,
  ENGAGEMENT_BACKOFF_MS,
  type Milestone,
  type PlaybackSession,
} from '../lib/engagement';
import { describeError, errorCodeOf, isUnavailable } from '../lib/errors';
import { mediaUrl, tokenNeedsRefresh } from '../lib/media';
import { tracker } from '../lib/runtime';
import { useSignedIn } from '../lib/session-context';
import { colors, space } from '../lib/theme';
import { useReducedMotion } from '../lib/useReducedMotion';

export interface PlayerProps {
  contentId: string;
  versionId: string;
  title: string;
  hls: string;
  poster: string | null;
  durationMs: number | null;
  /** Only the active card loads media and plays; others show the poster. */
  active: boolean;
  startMs?: number;
  /** The clip was retracted or hidden: the caller drops it from its list. */
  onUnavailable: () => void;
  /** A newer version is current: the caller refetches the item (its URLs and version id are stale). */
  onStale: () => void;
}

interface MediaToken {
  token: string;
  expiresAt: string;
}

export function Player(props: PlayerProps) {
  const { api, server, me } = useSignedIn();
  const reducedMotion = useReducedMotion();
  const ids = { userId: me.user.id, contentId: props.contentId, versionId: props.versionId };

  const tokenRef = useRef<MediaToken | null>(null);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const sentRef = useRef<Set<Milestone>>(new Set());
  const positionMsRef = useRef(0);
  const retriedRef = useRef(false);
  // Seek target applied once the replaced source is ready to play (a seek before that may be dropped).
  const pendingSeekRef = useRef<number | null>(null);
  const completedRef = useRef(false);
  const [posterUri, setPosterUri] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 1;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });

  const fetchToken = useCallback(async (): Promise<string | null> => {
    const result = await api.GET('/v1/content/{id}/media-token', {
      params: { path: { id: props.contentId } },
    });
    if (result.error || !result.data) {
      const code = errorCodeOf(result);
      if (isUnavailable(code, result.response.status)) props.onUnavailable();
      else setMessage(describeError(code, result.response.status));
      return null;
    }
    if (result.data.versionId !== props.versionId) {
      // A new version is current: this card's URLs are stale, the caller refetches the item.
      props.onStale();
      return null;
    }
    tokenRef.current = { token: result.data.token, expiresAt: result.data.expiresAt };
    if (props.poster) setPosterUri(mediaUrl(server.apiUrl, props.poster, result.data.token));
    return result.data.token;
  }, [api, props, server.apiUrl]);

  const load = useCallback(
    async (seekToMs: number, autoplay: boolean) => {
      let token = tokenRef.current;
      const fresh =
        !token || tokenNeedsRefresh(token.expiresAt, Date.now()) ? await fetchToken() : token.token;
      if (!fresh) return;
      token = tokenRef.current;
      const source: VideoSource = {
        uri: mediaUrl(server.apiUrl, props.hls, fresh),
        contentType: 'hls',
        metadata: { title: props.title },
      };
      try {
        const target = clampSeek(seekToMs, props.durationMs);
        pendingSeekRef.current = target > 0 ? target : null;
        await player.replaceAsync(source);
        if (target > 0) player.currentTime = target / 1000;
        if (autoplay) player.play();
        else setNeedsTap(true);
      } catch {
        setMessage(strings.feed.mediaError);
      }
    },
    [fetchToken, player, props.hls, props.title, server.apiUrl],
  );

  const send = useCallback(
    async (type: Milestone, positionMs: number) => {
      const session = sessionRef.current;
      if (!session || !tracker.take(ids, type)) return;
      try {
        const result = await api.POST('/v1/content/{id}/engagement', {
          params: { path: { id: props.contentId } },
          body: {
            versionId: props.versionId,
            sessionKey: session.sessionKey,
            type,
            positionMs: Math.min(2_147_483_647, Math.max(0, Math.round(positionMs))),
          },
        });
        if (result.error) {
          // The per-second timeUpdate would otherwise retry a refused milestone for the rest of playback.
          switch (classifyEngagementFailure(errorCodeOf(result), result.response.status)) {
            case 'unavailable':
              tracker.release(ids, type);
              props.onUnavailable();
              break;
            case 'stale':
              tracker.release(ids, type);
              props.onStale();
              break;
            case 'abandon':
              tracker.abandon(ids, type);
              break;
            default:
              tracker.release(ids, type, { retryAfterMs: ENGAGEMENT_BACKOFF_MS });
          }
          return;
        }
        await tracker.commit(ids, type);
        sentRef.current.add(type);
        if (type === 'complete') completedRef.current = true;
      } catch {
        tracker.release(ids, type, { retryAfterMs: ENGAGEMENT_BACKOFF_MS });
      }
    },
    // ids is derived from props; listing its parts keeps the callback stable per clip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, props.contentId, props.versionId, props.onUnavailable, props.onStale],
  );

  useEffect(() => {
    let live = true;
    if (props.active) {
      (async () => {
        const session = await tracker.start(ids);
        if (!live) return;
        sessionRef.current = session;
        sentRef.current = new Set(session.sent);
        await load(props.startMs ?? 0, !reducedMotion);
      })();
    } else {
      player.pause();
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.active, props.contentId, props.versionId]);

  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    if (!isPlaying) return;
    setNeedsTap(false);
    if (completedRef.current) {
      // Replay after completion: a new playback session, counted as a rewatch by the server.
      completedRef.current = false;
      void tracker.start(ids).then((session) => {
        sessionRef.current = session;
        sentRef.current = new Set(session.sent);
        void send('view_start', positionMsRef.current);
      });
      return;
    }
    void send('view_start', positionMsRef.current);
  });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    const positionMs = currentTime * 1000;
    positionMsRef.current = positionMs;
    const durationMs = player.duration > 0 ? player.duration * 1000 : props.durationMs;
    for (const m of dueMilestones(positionMs, durationMs, [...sentRef.current]))
      void send(m, positionMs);
  });
  useEventListener(player, 'playToEnd', () => {
    void send('complete', positionMsRef.current);
  });
  useEventListener(player, 'statusChange', ({ status: next }) => {
    // A source that became playable again (after a token refresh) may refresh again on the next expiry.
    if (next === 'readyToPlay') retriedRef.current = false;
    if (next === 'readyToPlay' && pendingSeekRef.current !== null) {
      const target = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (Math.abs(player.currentTime * 1000 - target) > 1500) player.currentTime = target / 1000;
      return;
    }
    if (next !== 'error') return;
    if (!retriedRef.current) {
      // Most likely an expired or rotated token: fetch a new one and resume where we were.
      retriedRef.current = true;
      tokenRef.current = null;
      void load(positionMsRef.current, true);
    } else {
      setMessage(strings.feed.mediaError);
    }
  });

  return (
    <View style={styles.box} accessibilityLabel={props.title}>
      {posterUri && status !== 'readyToPlay' && (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: posterUri }}
          style={styles.poster}
          resizeMode="contain"
        />
      )}
      <VideoView
        player={player}
        style={styles.video}
        contentFit="contain"
        nativeControls
        fullscreenOptions={{ enable: true }}
        accessibilityLabel={props.title}
      />
      {needsTap && !message && (
        <View style={styles.overlay} pointerEvents="box-none">
          <Button label={strings.feed.play} onPress={() => player.play()} />
        </View>
      )}
      {message && (
        <View style={styles.overlay}>
          <Text style={styles.message} accessibilityRole="alert">
            {message}
          </Text>
          <Button
            label={strings.common.retry}
            variant="secondary"
            onPress={() => {
              setMessage(null);
              retriedRef.current = false;
              tokenRef.current = null;
              void load(positionMsRef.current, true);
            }}
          />
        </View>
      )}
    </View>
  );
}

/** Keeps a requested start position inside the clip (an out-of-range `t` would otherwise complete it). */
export function clampSeek(seekToMs: number, durationMs: number | null): number {
  const wanted = Math.max(0, Math.floor(seekToMs));
  if (!durationMs || durationMs <= 0) return wanted;
  return Math.min(wanted, Math.max(0, durationMs - 1000));
}

const styles = StyleSheet.create({
  box: { flex: 1, backgroundColor: colors.video, justifyContent: 'center' },
  video: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  poster: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.lg,
    backgroundColor: colors.scrim,
  },
  message: { color: colors.onVideo, fontSize: 16, textAlign: 'center' },
});
