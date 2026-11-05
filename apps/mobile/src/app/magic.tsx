// SPDX-License-Identifier: Apache-2.0
// Magic-link landing. The link waits in the deep-link memory slot; it is consumed only when this
// device started the request (secure-store verifier) and the link names that request's server, and
// only when the user taps "Sign in" (no drive-by consumption). Decisions live in lib/magic-consume.ts.
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
  restoreMagicLink,
  takeMagicLink,
} from '../lib/deeplink';
import type { ServerConfig } from '../lib/discovery';
import { errorMessage } from '../lib/errors';
import { consumeMagicLink, resolveSwitch, type ConsumeOutcome } from '../lib/magic-consume';
import { loadMagicVerifier } from '../lib/magic-verifier';
import { ALLOW_LOOPBACK_HTTP } from '../lib/runtime';
import { useSession, type Me } from '../lib/session-context';
import { secureStore } from '../lib/storage';
import { base } from '../lib/theme';

type Incoming = Extract<ConsumeOutcome<Me>, { kind: 'confirmSwitch' }>;

export default function MagicScreen() {
  const router = useRouter();
  const session = useSession();
  const params = useLocalSearchParams<{ token?: string; server?: string }>();
  /** The server this device's request went to; null when no request is pending on this device. */
  const [server, setServer] = useState<ServerConfig | null | undefined>(undefined);
  const [pending, setPending] = useState(hasPendingMagicLink());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A consumed link for another account while a session exists: the user decides which to keep. */
  const [incoming, setIncoming] = useState<Incoming | null>(null);

  useEffect(() => {
    // Expo Router parses deep links itself; move what it captured into the memory slot and strip it
    // from the navigation state.
    if (params.token) {
      const url =
        `ourstream://magic?token=${encodeURIComponent(params.token)}` +
        (params.server ? `&server=${encodeURIComponent(params.server)}` : '');
      const accepted = offerMagicLink(url);
      setPending(accepted || hasPendingMagicLink());
      router.setParams({ token: undefined, server: undefined });
    }
  }, [params.token, params.server, router]);

  useEffect(() => {
    void loadMagicVerifier(secureStore, { allowLoopbackHttp: ALLOW_LOOPBACK_HTTP }).then((v) =>
      setServer(v ? v.server : null),
    );
  }, []);

  const consume = async () => {
    const link = takeMagicLink();
    if (!link) {
      setPending(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await consumeMagicLink<Me>(link, {
        store: secureStore,
        allowLoopbackHttp: ALLOW_LOOPBACK_HTTP,
        currentUserId: session.state.status === 'signedIn' ? session.state.me.user.id : null,
        consume: async (target, token, verifier) => {
          try {
            const api = createApi({ apiUrl: target.apiUrl });
            const result = await api.POST('/v1/auth/magic-link/consume', {
              body: { token, verifier },
            });
            const message = errorMessage(result);
            if (message || !result.data) return { kind: 'refused' };
            const { secret, me } = splitSignIn(result.data as Me & { sessionToken?: string });
            return secret ? { kind: 'ok', secret, me: me as Me } : { kind: 'refused' };
          } catch {
            return { kind: 'network' };
          }
        },
      });
      switch (outcome.kind) {
        case 'blocked':
          setError(strings.magic.notStarted);
          setPending(false);
          return;
        case 'refused':
          setError(strings.errors.invalidLink);
          setPending(false);
          return;
        case 'network':
          // Never reached the server: keep the link so the user can retry within the TTL.
          restoreMagicLink(link);
          setPending(true);
          setError(strings.errors.offline);
          return;
        case 'confirmSwitch':
          setIncoming(outcome);
          return;
        case 'signedIn':
          if (outcome.replacesSession && session.state.status === 'signedIn')
            await logoutBestEffort(session.state.api);
          await session.signIn(outcome.server, outcome.secret, outcome.me);
          router.replace('/(tabs)/feed');
          return;
      }
    } finally {
      setBusy(false);
    }
  };

  const choose = async (choice: 'switch' | 'keep') => {
    if (!incoming) return;
    setBusy(true);
    try {
      await resolveSwitch(choice, incoming, {
        logoutCurrent: async () => {
          if (session.state.status === 'signedIn') await logoutBestEffort(session.state.api);
        },
        signIn: (target, secret, me) => session.signIn(target, secret, me),
        // Revoke the session the link created so the unused secret does not stay valid server-side.
        revokeIncoming: (target, secret) =>
          logoutBestEffort(createApi({ apiUrl: target.apiUrl, secret })),
      });
      setIncoming(null);
      router.replace('/(tabs)/feed');
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
      {server === null && !error && <Notice text={strings.magic.notStarted} kind="error" />}
      {server && !pending && !error && <Notice text={strings.magic.failed} kind="error" />}
      {incoming && session.state.status === 'signedIn' && (
        <View style={base.card}>
          <Text style={base.heading}>{strings.magic.switchTitle(incoming.me.user.email)}</Text>
          <Text style={base.body}>{strings.magic.switchBody(session.state.me.user.email)}</Text>
          <View style={base.row}>
            <Button
              label={strings.magic.switchCancel}
              variant="secondary"
              onPress={() => void choose('keep')}
              disabled={busy}
            />
            <Button
              label={strings.magic.switchConfirm}
              onPress={() => void choose('switch')}
              busy={busy}
            />
          </View>
        </View>
      )}
      {server && pending && !incoming && (
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
      {!incoming && <Button label={strings.signIn.title} variant="link" onPress={toSignIn} />}
    </ScrollView>
  );
}
