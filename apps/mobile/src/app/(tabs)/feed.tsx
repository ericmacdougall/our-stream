// SPDX-License-Identifier: Apache-2.0
// Vertical feed: one clip per page, the visible card plays. Previous/next buttons give a
// non-gesture way to move (WCAG 2.5.7); reduce motion turns off autoplay and scroll animation.
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { FeedCard, type FeedItem } from '../../components/FeedCard';
import { Notice } from '../../components/Notice';
import { strings } from '../../i18n';
import { errorCodeOf, errorMessage, isUnavailable } from '../../lib/errors';
import {
  applyStaleItem,
  mergeItems,
  optimisticToggle,
  removeItem,
  withReaction,
} from '../../lib/feed';
import { useSignedIn, useSession } from '../../lib/session-context';
import { base, colors, space } from '../../lib/theme';
import { useReducedMotion } from '../../lib/useReducedMotion';

const PAGE = 10;

export default function FeedScreen() {
  const { api, me, server } = useSignedIn();
  const { signOut } = useSession();
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const list = useRef<FlatList<FeedItem>>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [height, setHeight] = useState(0);
  const likeBusy = useRef(new Set<string>());
  const lastActive = useRef<string | null>(null);
  const [, bump] = useState(0);

  const loadPage = useCallback(
    async (after: string | null, replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.GET('/v1/feed', {
          params: { query: { limit: PAGE, ...(after ? { cursor: after } : {}) } },
        });
        const message = errorMessage(result);
        if (message || !result.data) {
          if (errorCodeOf(result) === 'bad_cursor') {
            setCursor(null);
          }
          setError(message ?? strings.errors.generic);
          return;
        }
        setItems((prev) => (replace ? result.data!.items : mergeItems(prev, result.data!.items)));
        setCursor(result.data.nextCursor);
        if (replace && result.data.items[0]) setActiveId(result.data.items[0].id);
      } catch {
        setError(strings.errors.offline);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api],
  );

  useFocusEffect(
    useCallback(() => {
      if (items.length === 0) void loadPage(null, true);
      else if (lastActive.current) setActiveId(lastActive.current);
      // Leaving the tab pauses playback through `active`; the card is restored on return.
      return () =>
        setActiveId((cur) => {
          if (cur) lastActive.current = cur;
          return null;
        });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadPage]),
  );

  const onViewable = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item: FeedItem; isViewable: boolean }> }) => {
      const first = viewableItems.find((v) => v.isViewable);
      if (first?.item) setActiveId(first.item.id);
    },
  ).current;

  const unavailable = useCallback((id: string) => {
    setItems((prev) => removeItem(prev, id));
    setNotice(strings.feed.unavailable);
  }, []);

  // A newer version is current: refetch just that item and swap it in place, so the list, the
  // pagination cursor and the active card stay where the user is. One refetch per item at a time.
  const staleInFlight = useRef(new Set<string>());
  const stale = useCallback(
    async (id: string) => {
      if (staleInFlight.current.has(id)) return;
      staleInFlight.current.add(id);
      try {
        const result = await api.GET('/v1/content/{id}', { params: { path: { id } } });
        if (result.error || !result.data) {
          if (isUnavailable(errorCodeOf(result), result.response.status)) unavailable(id);
          return;
        }
        setItems((prev) => applyStaleItem(prev, result.data!));
      } catch {
        // Offline: the card keeps its current (stale) version; the backoff limits retries.
      } finally {
        staleInFlight.current.delete(id);
      }
    },
    [api, unavailable],
  );

  const toggleLike = async (item: FeedItem) => {
    if (likeBusy.current.has(item.id)) return;
    likeBusy.current.add(item.id);
    bump((n) => n + 1);
    const before = item;
    setItems((prev) => prev.map((i) => (i.id === item.id ? optimisticToggle(i) : i)));
    try {
      const params = { params: { path: { id: item.id } } };
      const result = before.liked
        ? await api.DELETE('/v1/content/{id}/like', params)
        : await api.POST('/v1/content/{id}/like', params);
      if (result.error || !result.data) {
        if (isUnavailable(errorCodeOf(result), result.response.status)) unavailable(item.id);
        else {
          setItems((prev) => withReaction(prev, item.id, before));
          setNotice(errorMessage(result));
        }
        return;
      }
      setItems((prev) => withReaction(prev, item.id, result.data!));
    } catch {
      setItems((prev) => withReaction(prev, item.id, before));
      setNotice(strings.errors.offline);
    } finally {
      likeBusy.current.delete(item.id);
      bump((n) => n + 1);
    }
  };

  const index = items.findIndex((i) => i.id === activeId);
  const go = (delta: number) => {
    const next = Math.min(items.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta));
    list.current?.scrollToIndex({ index: next, animated: !reducedMotion });
    setActiveId(items[next]?.id ?? null);
  };

  return (
    <View style={base.page}>
      <View style={styles.bar}>
        <Text style={base.muted} numberOfLines={1}>
          {strings.account.signedInAs(me.user.email)} · {new URL(server.apiUrl).host}
        </Text>
        <Button label={strings.common.signOut} variant="link" onPress={() => void signOut()} />
      </View>
      <Notice text={error ?? notice} kind={error ? 'error' : 'info'} />
      <View
        style={styles.list}
        onLayout={(e) => setHeight(Math.round(e.nativeEvent.layout.height))}
      >
        {height > 0 && (
          <FlatList
            ref={list}
            data={items}
            keyExtractor={(i) => i.id}
            pagingEnabled
            snapToInterval={height}
            decelerationRate="fast"
            showsVerticalScrollIndicator={false}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
            getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
            onEndReachedThreshold={1}
            onEndReached={() => {
              if (cursor && !loading) void loadPage(cursor, false);
            }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => {
                  setRefreshing(true);
                  void loadPage(null, true);
                }}
                tintColor={colors.accent}
              />
            }
            ListEmptyComponent={
              <View style={[base.pad, { height, justifyContent: 'center' }]}>
                <Text style={base.body}>
                  {loading ? strings.common.loading : strings.feed.empty}
                </Text>
                {!loading && (
                  <Button
                    label={strings.common.retry}
                    variant="secondary"
                    onPress={() => void loadPage(null, true)}
                  />
                )}
              </View>
            }
            renderItem={({ item }) => (
              <FeedCard
                item={item}
                active={item.id === activeId}
                height={height}
                likeBusy={likeBusy.current.has(item.id)}
                onToggleLike={() => void toggleLike(item)}
                onOpenComments={() =>
                  router.push({ pathname: '/content/[id]', params: { id: item.id } })
                }
                onShare={() =>
                  router.push({ pathname: '/content/[id]/share', params: { id: item.id } })
                }
                onUnavailable={() => unavailable(item.id)}
                onStale={() => void stale(item.id)}
              />
            )}
          />
        )}
      </View>
      {items.length > 1 && (
        <View style={styles.nav}>
          <Button
            label={strings.feed.previous}
            variant="secondary"
            onPress={() => go(-1)}
            disabled={index <= 0}
          />
          <Text style={base.muted} accessibilityLiveRegion="polite">
            {index + 1} / {items.length}
          </Text>
          <Button
            label={strings.feed.next}
            variant="secondary"
            onPress={() => go(1)}
            disabled={index >= items.length - 1}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    gap: space.sm,
  },
  list: { flex: 1 },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space.sm,
    gap: space.sm,
  },
});
