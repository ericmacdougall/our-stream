// SPDX-License-Identifier: Apache-2.0
// Magic-link landing. The token waits in the deep-link memory slot; it is consumed only against the
// last confirmed server and only when the user taps "Sign in" (no drive-by consumption).
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { strings } from '../i18n';
import { createApi, logoutBestEffort, splitSignIn } from '../lib/api';
import {
  discardMagicLink,
  hasPendingMagicLink,
  offerMagicLink,
  takeMagicToken,
} from '../lib/deeplink';
import type { ServerConfig } from '../lib/discovery';
import { errorMessage } from '../lib/errors';
import { ALLOW_LOOPBACK_HTTP } from '../lib/runtime';
import { loadLastServer } from '../lib/session';
import { useSession, type Me } from '../lib/session-context';
import { secureStore } from '../lib/storage';
import { base } from '../lib/theme';

export default function MagicScreen() {
  const router = useRouter();
  const session = useSession();
  const params = useLocalSearchParams<{ token?: string }>();
  const [server, setServer] = useState<ServerConfig | null | undefined>(undefined);
  const [pending, setPending] = useState(hasPendingMagicLink());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Expo Router parses deep links itself; move a token it captured into the memory slot and strip
    // it from the navigation state.
    if (params.token) {
      const accepted = offerMagicLink(
        `ourstream://magic?token=${encodeURIComponent(params.token)}`,
      );
      setPending(accepted || hasPendingMagicLink());
      router.setParams({ token: undefined });
    }
  }, [params.token, router]);

  useEffect(() => {
    void loadLastServer(secureStore, { allowLoopbackHttp: ALLOW_LOOPBACK_HTTP }).then(setServer);
  }, []);

  const consume = async () => {
    if (!server) return;
    const token = takeMagicToken();
    if (!token) {
      setPending(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Validate the link first; an invalid or crafted link must not touch the current session.
      const api = createApi({ apiUrl: server.apiUrl });
      const result = await api.POST('/v1/auth/magic-link/consume', { body: { token } });
      const message = errorMessage(result);
      if (message || !result.data) {
        setError(message ?? strings.errors.generic);
        setPending(false);
        return;
      }
      const { secret, me } = splitSignIn(result.data as Me & { sessionToken?: string });
      if (!secret) {
        setError(strings.errors.generic);
        setPending(false);
        return;
      }
      if (session.state.status === 'signedIn') await logoutBestEffort(session.state.api);
      await session.signIn(server, secret, me);
      router.replace('/(tabs)/feed');
    } catch {
      setError(strings.errors.offline);
      setPending(false);
    } finally {
      setBusy(false);
    }
  };

  const toSignIn = () => {
    discardMagicLink();
    router.replace('/sign-in');
  };

  return (
    <ScrollView contentContainerStyle={base.pad} style={base.page}>
      <Text accessibilityRole="header" style={base.title}>
        {strings.magic.title}
      </Text>
      <Notice text={error} kind="error" />
      {server === null && <Notice text={strings.magic.needServer} />}
      {server && !pending && !error && <Notice text={strings.magic.failed} kind="error" />}
      {server && pending && (
        <View style={base.card}>
          <Text style={base.body}>
            {strings.signIn.serverLabel}: {new URL(server.apiUrl).host}
          </Text>
          {session.state.status === 'signedIn' && (
            <Text style={base.muted}>{strings.magic.replaces(session.state.me.user.email)}</Text>
          )}
          <Button label={strings.signIn.submit} onPress={() => void consume()} busy={busy} />
        </View>
      )}
      <Button label={strings.signIn.title} variant="link" onPress={toSignIn} />
    </ScrollView>
  );
}
