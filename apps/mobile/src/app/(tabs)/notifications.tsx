// SPDX-License-Identifier: Apache-2.0
import type { Notification } from '@our-stream/contracts';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { z } from 'zod';
import { Notice } from '../../components/Notice';
import { strings } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { useSignedIn } from '../../lib/session-context';
import { base, colors, space } from '../../lib/theme';

type Item = z.output<typeof Notification>;
const t = strings.notifications;

export default function NotificationsScreen() {
  const { api } = useSignedIn();
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.GET('/v1/notifications');
      const message = errorMessage(result);
      if (message || !result.data) {
        setError(message ?? strings.errors.generic);
        return;
      }
      setItems(result.data.items);
      setUnread(result.data.unread);
    } catch {
      setError(strings.errors.offline);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const open = async (item: Item) => {
    if (!item.readAt) {
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, readAt: new Date().toISOString() } : i)),
      );
      setUnread((n) => Math.max(0, n - 1));
      // Best effort: a failed mark-read never blocks navigation.
      void api
        .POST('/v1/notifications/{id}/read', { params: { path: { id: item.id } } })
        .catch(() => {});
    }
    if (item.contentId && item.title)
      router.push({ pathname: '/content/[id]', params: { id: item.contentId } });
  };

  return (
    <View style={base.page}>
      <View style={[base.pad, { paddingBottom: space.sm }]}>
        <Text style={base.muted} accessibilityLiveRegion="polite">
          {unread > 0 ? `${unread} ${t.unread.toLowerCase()}` : ''}
        </Text>
        <Notice text={error} kind="error" />
      </View>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{
          paddingHorizontal: space.lg,
          paddingBottom: space.xl,
          gap: space.sm,
        }}
        onRefresh={() => void load()}
        refreshing={loading}
        ListEmptyComponent={!loading ? <Text style={base.body}>{t.empty}</Text> : undefined}
        renderItem={({ item }) => {
          const navigable = !!(item.contentId && item.title);
          const label = `${item.title ?? t.noContent}. ${item.reason}${item.readAt ? '' : `. ${t.unread}`}`;
          return (
            <Pressable
              accessibilityRole={navigable ? 'button' : 'text'}
              accessibilityLabel={label}
              accessibilityState={{ disabled: !navigable }}
              disabled={!navigable && !!item.readAt}
              onPress={() => void open(item)}
              style={({ pressed }) => [
                base.card,
                styles.row,
                pressed && styles.pressed,
                !item.readAt && styles.unread,
              ]}
            >
              <View style={{ flex: 1, gap: space.xs }}>
                <Text style={[base.body, !item.readAt && styles.bold]}>
                  {item.title ?? t.noContent}
                </Text>
                <Text style={base.muted}>{item.reason}</Text>
                <Text style={base.muted}>{new Date(item.createdAt).toLocaleString()}</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  pressed: { opacity: 0.7 },
  unread: { borderColor: colors.accent },
  bold: { fontWeight: '700' },
});
