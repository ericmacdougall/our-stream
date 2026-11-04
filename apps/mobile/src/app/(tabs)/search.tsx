// SPDX-License-Identifier: Apache-2.0
// Keyword search (ADR-0013). The query text is sent to the API only; it is never logged here.
import type { SearchHit } from '@our-stream/contracts';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { z } from 'zod';
import { Button } from '../../components/Button';
import { Notice } from '../../components/Notice';
import { Snippet } from '../../components/Snippet';
import { strings } from '../../i18n';
import { errorMessage } from '../../lib/errors';
import { mergeItems } from '../../lib/feed';
import { useSignedIn } from '../../lib/session-context';
import { formatTimestamp } from '../../lib/snippets';
import { base, colors, space } from '../../lib/theme';

type Hit = z.output<typeof SearchHit>;
const t = strings.search;
const MAX_Q = 200;

export default function SearchScreen() {
  const { api } = useSignedIn();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const run = async (query: string, after: string | null) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.GET('/v1/search', {
        params: { query: { q: query, limit: 20, ...(after ? { cursor: after } : {}) } },
      });
      if (id !== requestId.current) return;
      const message = errorMessage(result);
      if (message || !result.data) {
        setError(message ?? strings.errors.generic);
        return;
      }
      setHits((prev) => (after ? mergeItems(prev, result.data!.items) : result.data!.items));
      setTotal(result.data.total);
      setCursor(result.data.nextCursor);
    } catch {
      if (id === requestId.current) setError(strings.errors.offline);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    const query = q.trim().slice(0, MAX_Q);
    if (!query) {
      requestId.current++;
      setHits([]);
      setTotal(null);
      setCursor(null);
      return;
    }
    const timer = setTimeout(() => void run(query, null), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const open = (hit: Hit, tMs: number | null) =>
    router.push({
      pathname: '/content/[id]',
      params: { id: hit.id, ...(tMs !== null ? { t: String(tMs) } : {}) },
    });

  return (
    <View style={base.page}>
      <View style={[base.pad, { paddingBottom: space.sm }]}>
        <TextInput
          accessibilityLabel={t.inputLabel}
          accessibilityRole="search"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          maxLength={MAX_Q}
          placeholder={t.placeholder}
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          onSubmitEditing={() => void run(q.trim(), null)}
          style={base.input}
          value={q}
          onChangeText={setQ}
        />
        <Notice text={error} kind="error" />
        {total !== null && (
          <Text style={base.muted} accessibilityLiveRegion="polite">
            {total === 0 ? t.none : t.results(total)}
          </Text>
        )}
      </View>
      <FlatList
        data={hits}
        keyExtractor={(h) => h.id}
        contentContainerStyle={{
          paddingHorizontal: space.lg,
          paddingBottom: space.xl,
          gap: space.md,
        }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <View style={base.card}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.title}, ${strings.feed.by(item.owner.displayName)}`}
              accessibilityHint={t.openHint}
              onPress={() => open(item, item.snippets.find((s) => s.tMs !== null)?.tMs ?? null)}
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <Text style={base.heading}>{item.title}</Text>
              <Text style={base.muted}>
                {strings.feed.by(item.owner.displayName)}
                {item.streams[0] ? ` · ${item.streams[0].name}` : ''}
              </Text>
            </Pressable>
            {item.snippets.map((s, i) => (
              <View key={i} style={styles.snippet}>
                <Text style={styles.source}>{t.source[s.source] ?? s.source}</Text>
                <Snippet text={s.text} ranges={s.ranges} />
                {s.tMs !== null && (
                  <Button
                    label={t.openAt(formatTimestamp(s.tMs))}
                    variant="link"
                    onPress={() => open(item, s.tMs)}
                    style={{ alignSelf: 'flex-start' }}
                  />
                )}
              </View>
            ))}
          </View>
        )}
        ListFooterComponent={
          cursor ? (
            <Button
              label={strings.feed.loadMore}
              variant="secondary"
              busy={loading}
              onPress={() => void run(q.trim(), cursor)}
            />
          ) : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  snippet: { gap: space.xs, paddingTop: space.xs },
  source: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase' },
});
