// SPDX-License-Identifier: AGPL-3.0-only
'use client';
// Vertical feed: one clip per viewport with CSS scroll-snap, muted autoplay on the active item,
// keyboard navigation, persistent play/mute/captions controls, a pause-auto-advance toggle
// (WCAG 2.2.2), disableable single-key shortcuts (2.1.4), reduced-motion handling (no autoplay,
// no auto-advance, no smooth scroll), view events, /sync polling and cursor-based infinite scroll.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { z } from 'zod';
import type { FeedItemM1b } from '@our-stream/contracts';
import { browserApi } from '@/lib/api/client';
import { clearAllCaches } from '@/lib/caches';
import { errorMessage } from '@/lib/errors';
import {
  emptyFeedState,
  epochsChanged,
  mergePage,
  removeItem,
  shouldLoadMore,
  type FeedPagesState,
} from '@/lib/feed/cursor';
import { withM1bDefaults } from '@/lib/m1b/api';
import { CommentsPanel } from '../comments/CommentsPanel';
import { ShareDialog } from '../share/ShareDialog';
import { feedKeyAction, stepIndex } from '@/lib/feed/keyboard';
import {
  DEFAULT_FEED_SETTINGS,
  feedSettingsReducer,
  loadFeedSettings,
  saveFeedSettings,
} from '@/lib/feed/settings';
import { t } from '@/lib/i18n';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { Notice } from '../Notice';
import { ExternalLinkDialog } from './ExternalLinkDialog';
import { FeedItemView } from './FeedItemView';

type Item = z.output<typeof FeedItemM1b>;
const PAGE_SIZE = 10;
const SYNC_INTERVAL_MS = 30_000;

export function Feed({ streamId }: { streamId?: string }) {
  const reducedMotion = useReducedMotion();
  const [settings, dispatch] = useReducer(feedSettingsReducer, DEFAULT_FEED_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<FeedPagesState<Item>>(emptyFeedState<Item>());
  const [activeIndex, setActiveIndex] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  // Under reduced motion nothing plays until the viewer explicitly starts playback.
  const [userStarted, setUserStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [external, setExternal] = useState<{ url: string; label: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  // M1b: which item's comments drawer is open, which item is being shared.
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  const [shareFor, setShareFor] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const loadingRef = useRef(false);
  const generation = useRef(0);
  const viewStarted = useRef(new Set<string>());
  const viewCompleted = useRef(new Set<string>());
  const stateRef = useRef(state);
  stateRef.current = state;
  // While a programmatic (keyboard / auto-advance) scroll is in flight the observer must not flip
  // the active item back to the one still mostly visible mid-animation.
  const pendingScroll = useRef<{ index: number; until: number } | null>(null);

  // Device-local preferences.
  useEffect(() => {
    dispatch({ type: 'hydrate', value: loadFeedSettings() });
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) saveFeedSettings(settings);
  }, [settings, hydrated]);

  const loadPage = useCallback(
    async (cursor: string | null, reset: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      const gen = reset ? ++generation.current : generation.current;
      try {
        const query: { limit: number; cursor?: string; streamId?: string } = { limit: PAGE_SIZE };
        if (cursor) query.cursor = cursor;
        if (streamId) query.streamId = streamId;
        const result = await browserApi().GET('/v1/feed', { params: { query } });
        if (gen !== generation.current) return;
        const message = errorMessage(result);
        if (message || !result.data) {
          setError(message ?? t('error.generic'));
          return;
        }
        // M1b fields are additive; an M1a-only server leaves them out, so fill defaults once here.
        const page = { ...result.data, items: result.data.items.map(withM1bDefaults) };
        setState((prev) => mergePage(reset ? emptyFeedState<Item>() : prev, page));
      } catch {
        if (gen === generation.current) setError(t('error.network'));
      } finally {
        if (gen === generation.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [streamId],
  );

  const refetchAll = useCallback(async () => {
    await clearAllCaches();
    viewStarted.current.clear();
    viewCompleted.current.clear();
    loadingRef.current = false;
    setActiveIndex(0);
    await loadPage(null, true);
  }, [loadPage]);

  // First page and stream changes.
  useEffect(() => {
    void refetchAll();
  }, [refetchAll]);

  // Infinite scroll.
  useEffect(() => {
    if (!loading && shouldLoadMore(activeIndex, state) && state.nextCursor) {
      void loadPage(state.nextCursor, false);
    }
  }, [activeIndex, state, loading, loadPage]);

  // Epoch polling (ADR-0004): drop everything and refetch when the server's epochs move.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const { data } = await browserApi().GET('/v1/sync');
        if (data && epochsChanged(stateRef.current.epochs, data)) {
          setAnnounce(t('feed.refreshed'));
          await refetchAll();
        }
      } catch {
        // Offline: keep showing what we have; the next tick retries.
      }
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refetchAll]);

  // Active item follows the viewport.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let best: { index: number; ratio: number } | null = null;
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset['index']);
          if (entry.isIntersecting && (!best || entry.intersectionRatio > best.ratio)) {
            best = { index, ratio: entry.intersectionRatio };
          }
        }
        if (!best || best.ratio < 0.6) return;
        const pending = pendingScroll.current;
        if (pending && Date.now() < pending.until) {
          if (best.index !== pending.index) return;
          pendingScroll.current = null;
        } else {
          pendingScroll.current = null;
        }
        setActiveIndex(best.index);
      },
      { root: container, threshold: [0.6, 0.9] },
    );
    for (const el of itemRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [state.items]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const item = stateRef.current.items[index];
      if (!item) return;
      const el = itemRefs.current.get(item.id);
      pendingScroll.current = { index, until: Date.now() + 1500 };
      el?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      setActiveIndex(index);
      el?.focus({ preventScroll: true });
    },
    [reducedMotion],
  );

  const activeItem = state.items[activeIndex] ?? null;
  const shouldPlayActive = !userPaused && !(reducedMotion && !userStarted);

  const togglePlay = useCallback(() => {
    if (reducedMotion && !userStarted) {
      setUserStarted(true);
      setUserPaused(false);
      return;
    }
    setUserPaused((p) => !p);
  }, [reducedMotion, userStarted]);

  // Keyboard.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const action = feedKeyAction(
        {
          key: e.key,
          targetTag: target?.tagName.toLowerCase() ?? 'body',
          isEditable: Boolean(target?.isContentEditable),
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        },
        { singleKeyShortcuts: settings.singleKeyShortcuts },
      );
      if (!action) return;
      if (document.querySelector('dialog[open]')) return;
      // Reading or typing in the comments drawer (or any region that opts out) never drives the feed.
      if (target?.closest('[data-shortcuts-off]')) return;
      e.preventDefault();
      switch (action) {
        case 'next':
        case 'prev':
          scrollToIndex(stepIndex(activeIndex, action, stateRef.current.items.length));
          break;
        case 'togglePlay':
          togglePlay();
          break;
        case 'toggleCaptions':
          dispatch({ type: 'toggleCaptions' });
          break;
        case 'toggleMute':
          dispatch({ type: 'toggleMute' });
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIndex, settings.singleKeyShortcuts, scrollToIndex, togglePlay]);

  async function sendView(item: Item, completed: boolean) {
    const set = completed ? viewCompleted.current : viewStarted.current;
    if (set.has(item.id)) return;
    set.add(item.id);
    try {
      await browserApi().POST('/v1/content/{id}/view', {
        params: { path: { id: item.id } },
        body: { versionId: item.versionId, completed },
      });
    } catch {
      set.delete(item.id);
    }
  }

  // The server says a clip is gone for this viewer (retracted, expired, access revoked): drop it,
  // close anything open for it, announce, and keep the keyboard user on a real item.
  function markUnavailable(id: string) {
    const items = stateRef.current.items;
    const index = items.findIndex((i) => i.id === id);
    if (index < 0) return;
    setState((prev) => removeItem(prev, id));
    setCommentsFor((c) => (c === id ? null : c));
    setShareFor((s) => (s === id ? null : s));
    setAnnounce(t('feed.noLongerAvailable'));
    const next = items[index + 1] ?? items[index - 1];
    if (next) {
      requestAnimationFrame(() => itemRefs.current.get(next.id)?.focus({ preventScroll: true }));
    }
  }

  function onEnded(index: number) {
    const item = state.items[index];
    if (item) void sendView(item, true);
    if (settings.autoAdvance && !reducedMotion && index === activeIndex) {
      const next = index + 1;
      if (next < state.items.length) scrollToIndex(next);
    }
  }

  return (
    <div className="feed-shell">
      <div className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </div>
      <div
        ref={containerRef}
        className={`feed${reducedMotion ? ' reduced-motion' : ''}`}
        data-testid="feed"
        aria-label={t('feed.label')}
      >
        {state.items.map((item, index) => (
          <FeedItemView
            key={item.id}
            ref={(el) => {
              if (el) itemRefs.current.set(item.id, el);
              else itemRefs.current.delete(item.id);
            }}
            item={item}
            index={index}
            active={index === activeIndex}
            warm={Math.abs(index - activeIndex) <= 1}
            shouldPlay={index === activeIndex && shouldPlayActive}
            settings={settings}
            reducedMotion={reducedMotion}
            commentsOpen={commentsFor === item.id}
            onPlaying={() => void sendView(item, false)}
            onEnded={() => onEnded(index)}
            onTogglePlay={togglePlay}
            onExternalLink={(url, label) => setExternal({ url, label })}
            onError={() => setAnnounce(t('feed.playbackError'))}
            onOpenComments={() => setCommentsFor((c) => (c === item.id ? null : item.id))}
            onShare={() => setShareFor(item.id)}
            onUnavailable={() => markUnavailable(item.id)}
          />
        ))}
        {!loading && state.items.length === 0 && !error ? (
          <section className="feed-item feed-empty" aria-labelledby="feed-empty-heading">
            <h2 id="feed-empty-heading">{t('feed.emptyTitle')}</h2>
            <p className="muted">{t('feed.emptyBody')}</p>
          </section>
        ) : null}
        {loading ? (
          <p className="feed-loading" role="status">
            {t('common.loading')}
          </p>
        ) : null}
        <Notice kind="error">{error}</Notice>
      </div>
      {commentsFor && activeItem ? (
        <CommentsPanel
          key={commentsFor}
          contentId={commentsFor}
          title={stateRef.current.items.find((i) => i.id === commentsFor)?.title ?? ''}
          onClose={() => setCommentsFor(null)}
          onUnavailable={() => markUnavailable(commentsFor)}
          onCountDelta={(delta) =>
            setState((prev) => ({
              ...prev,
              items: prev.items.map((i) =>
                i.id === commentsFor
                  ? { ...i, commentCount: Math.max(0, i.commentCount + delta) }
                  : i,
              ),
            }))
          }
        />
      ) : null}
      <ShareDialog
        contentId={shareFor}
        title={stateRef.current.items.find((i) => i.id === shareFor)?.title ?? ''}
        onClose={() => setShareFor(null)}
        onUnavailable={markUnavailable}
      />
      <div className="feed-controls" role="toolbar" aria-label={t('feed.controls')}>
        <button type="button" onClick={togglePlay} data-testid="toggle-play" disabled={!activeItem}>
          {shouldPlayActive ? t('feed.pause') : t('feed.play')}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'toggleMute' })}
          data-testid="toggle-mute"
        >
          {settings.muted ? t('feed.unmute') : t('feed.mute')}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'toggleCaptions' })}
          data-testid="toggle-captions"
        >
          {settings.captions ? t('feed.captionsOff') : t('feed.captionsOn')}
        </button>
        <details className="feed-settings">
          <summary>{t('feed.settings')}</summary>
          <label className="inline">
            <input
              type="checkbox"
              checked={settings.autoAdvance}
              data-testid="setting-auto-advance"
              onChange={(e) => dispatch({ type: 'setAutoAdvance', value: e.target.checked })}
            />{' '}
            {t('feed.autoAdvance')}
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={settings.singleKeyShortcuts}
              data-testid="setting-shortcuts"
              onChange={(e) => dispatch({ type: 'setSingleKeyShortcuts', value: e.target.checked })}
            />{' '}
            {t('feed.singleKeyShortcuts')}
          </label>
          <p className="muted">{t('feed.shortcutsHelp')}</p>
        </details>
      </div>
      <ExternalLinkDialog
        url={external?.url ?? null}
        label={external?.label ?? ''}
        onClose={() => setExternal(null)}
      />
    </div>
  );
}
