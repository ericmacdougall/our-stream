// SPDX-License-Identifier: Apache-2.0
// M0 shell: proves the Expo app builds in the workspace and reaches the API through the shared
// contract (ADR-0011: separate UI, shared packages). Sign-in and the feed arrive with M1b.
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { createClient, type MetaResponse } from '@our-stream/contracts';
import { strings } from '../i18n';

const API_URL = process.env['EXPO_PUBLIC_API_URL'] ?? 'http://localhost:4000';

export default function HomeScreen() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const client = createClient({ baseUrl: API_URL });
    client
      .GET('/v1/meta')
      .then(({ data }) => {
        if (!cancelled) setMeta(data ?? null);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceUrl = meta?.sourceUrl ?? 'https://github.com/ericmacdougall/our-stream';

  return (
    <View style={styles.page}>
      <Text accessibilityRole="header" style={styles.title}>
        {strings.appName}
      </Text>
      <Text style={styles.muted}>{strings.tagline}</Text>
      <View style={styles.card} accessibilityLabel={strings.statusHeading}>
        <Text style={styles.heading}>{strings.statusHeading}</Text>
        <Text>
          {meta
            ? strings.apiReachable(meta.version)
            : failed
              ? strings.apiUnreachable
              : strings.loading}
        </Text>
      </View>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={strings.sourceLink}
        onPress={() => void Linking.openURL(sourceUrl)}
        style={({ pressed }) => [styles.link, pressed && styles.linkPressed]}
      >
        <Text style={styles.linkText}>{strings.sourceLink}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, gap: 16, backgroundColor: '#f7f7f5' },
  title: { fontSize: 28, fontWeight: '700', color: '#1b1c1a' },
  muted: { color: '#55574f' },
  heading: { fontSize: 18, fontWeight: '600', marginBottom: 8, color: '#1b1c1a' },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d9d9d3',
    padding: 16,
  },
  link: { paddingVertical: 12, minHeight: 44, justifyContent: 'center' },
  linkPressed: { opacity: 0.6 },
  linkText: { color: '#1f6f5f', textDecorationLine: 'underline' },
});
