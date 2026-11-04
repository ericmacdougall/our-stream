// SPDX-License-Identifier: Apache-2.0
// Share as link (ADR-0002: sharing never grants access). The recipient gets a notification; the
// text offered to the share sheet is the server's linkPath on the web origin, never a media URL.
import type { MemberSummary } from '@our-stream/contracts';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { z } from 'zod';
import { Button } from '../../../components/Button';
import { Notice } from '../../../components/Notice';
import { strings } from '../../../i18n';
import { errorCodeOf, errorMessage, isUnavailable } from '../../../lib/errors';
import { shareText } from '../../../lib/media';
import { useSession, useSignedIn } from '../../../lib/session-context';
import { base, colors, space } from '../../../lib/theme';

type Member = z.output<typeof MemberSummary>;
const t = strings.share;

/** Direct loads (deep links, web SSR) reach this route before the session exists: gate it. */
export default function ShareScreenRoute() {
  const { state } = useSession();
  if (state.status === 'loading') return null;
  if (state.status === 'signedOut') return <Redirect href="/sign-in" />;
  return <ShareScreen />;
}

function ShareScreen() {
  const { api, me, server } = useSignedIn();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [members, setMembers] = useState<Member[]>([]);
  const [filter, setFilter] = useState('');
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ delivered: boolean; link: string } | null>(null);

  useEffect(() => {
    let live = true;
    api
      .GET('/v1/members')
      .then((result) => {
        if (!live) return;
        if (result.error || !result.data) setError(errorMessage(result));
        else {
          setMembers(
            result.data.items.filter(
              (m: Member) => m.status === 'active' && m.userId !== me.user.id,
            ),
          );
        }
      })
      .catch(() => live && setError(strings.errors.offline));
    return () => {
      live = false;
    };
  }, [api, me.user.id]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? members.filter((m) => m.displayName.toLowerCase().includes(q)) : members;
    return [...list].sort((a, b) => a.displayName.localeCompare(b.displayName)).slice(0, 50);
  }, [members, filter]);

  const send = async (member: Member) => {
    if (busyFor) return;
    setBusyFor(member.userId);
    setError(null);
    try {
      const result = await api.POST('/v1/content/{id}/share', {
        params: { path: { id } },
        body: { userId: member.userId },
      });
      if (result.error || !result.data) {
        if (isUnavailable(errorCodeOf(result), result.response.status))
          setError(strings.feed.unavailable);
        else setError(errorMessage(result));
        return;
      }
      setOutcome({
        delivered: result.data.delivered,
        link: shareText(server.webUrl, result.data.linkPath),
      });
    } catch {
      setError(strings.errors.offline);
    } finally {
      setBusyFor(null);
    }
  };

  return (
    <View style={base.page}>
      <View style={[base.pad, { paddingBottom: space.sm }]}>
        <Text style={base.body}>{t.intro}</Text>
        <Notice text={error} kind="error" />
        {outcome && (
          <View style={base.card}>
            <Notice text={outcome.delivered ? t.delivered : t.notDelivered} />
            {outcome.delivered && (
              <Button
                label={t.openSheet}
                onPress={() =>
                  void Share.share(
                    Platform.OS === 'ios' ? { url: outcome.link } : { message: outcome.link },
                  ).catch(() => {})
                }
              />
            )}
            <Button
              label={strings.common.close}
              variant="secondary"
              onPress={() => router.back()}
            />
          </View>
        )}
        <TextInput
          accessibilityLabel={t.searchLabel}
          accessibilityRole="search"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t.placeholder}
          placeholderTextColor={colors.muted}
          style={base.input}
          value={filter}
          onChangeText={setFilter}
        />
      </View>
      <FlatList
        data={shown}
        keyExtractor={(m) => m.userId}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: space.lg,
          paddingBottom: space.xl,
          gap: space.sm,
        }}
        ListEmptyComponent={
          <Text style={base.body}>
            {members.length === 0 && !error ? strings.common.loading : t.noMembers}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.sendTo(item.displayName)}
            accessibilityState={{ busy: busyFor === item.userId, disabled: !!busyFor }}
            disabled={!!busyFor}
            onPress={() => void send(item)}
            style={({ pressed }) => [base.card, styles.row, pressed && styles.pressed]}
          >
            <Text style={base.body}>{item.displayName}</Text>
            <Text style={base.muted}>{item.role}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pressed: { opacity: 0.7 },
});
