// SPDX-License-Identifier: Apache-2.0
// Manual server address (Q5 fallback). Pins the probed server for the email domain the sign-in
// screen passed, then returns there.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { strings } from '../i18n';
import type { ServerConfig } from '../lib/discovery';
import { ALLOW_LOOPBACK_HTTP } from '../lib/runtime';
import { normaliseServerInput, probeServer } from '../lib/server';
import { pinServer, saveLastServer } from '../lib/session';
import { secureStore } from '../lib/storage';
import { base, colors } from '../lib/theme';

const t = strings.server;

export default function ServerScreen() {
  const router = useRouter();
  const { domain } = useLocalSearchParams<{ domain?: string }>();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<ServerConfig | null>(null);

  const check = async () => {
    setError(null);
    setFound(null);
    const url = normaliseServerInput(input, { allowLoopbackHttp: ALLOW_LOOPBACK_HTTP });
    if (!url) {
      setError(t.invalid);
      return;
    }
    setBusy(true);
    try {
      const server = await probeServer(url, { fetch });
      if (server) setFound(server);
      else setError(t.notFound);
    } finally {
      setBusy(false);
    }
  };

  const use = async (server: ServerConfig) => {
    if (domain) await pinServer(secureStore, domain, server);
    await saveLastServer(secureStore, server);
    router.back();
  };

  return (
    <ScrollView
      contentContainerStyle={base.pad}
      style={base.page}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={base.title}>
        {t.title}
      </Text>
      <Text style={base.body}>{t.intro}</Text>
      <View style={base.card}>
        <Text style={base.label} nativeID="server-label">
          {t.inputLabel}
        </Text>
        <TextInput
          accessibilityLabel={t.inputLabel}
          accessibilityLabelledBy="server-label"
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          keyboardType="url"
          placeholder={t.placeholder}
          placeholderTextColor={colors.muted}
          returnKeyType="go"
          onSubmitEditing={() => void check()}
          style={base.input}
          value={input}
          onChangeText={(v) => {
            setInput(v);
            setFound(null);
          }}
        />
        <Button
          label={t.check}
          onPress={() => void check()}
          busy={busy}
          disabled={input.trim().length === 0}
        />
        <Notice text={error} kind="error" />
        {found && (
          <>
            <Notice text={t.found(new URL(found.apiUrl).host)} />
            <Button label={t.use} onPress={() => void use(found)} />
          </>
        )}
      </View>
    </ScrollView>
  );
}
