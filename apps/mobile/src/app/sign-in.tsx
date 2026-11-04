// SPDX-License-Identifier: Apache-2.0
// Sign-in: email → server discovery (or the pinned server) → confirm the server once → password or
// magic link. The server is shown before any credential is typed (Q5 trust rule).
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { strings } from '../i18n';
import { createApi } from '../lib/api';
import { discoverServer, emailDomain, hostRelation, type ServerConfig } from '../lib/discovery';
import { errorMessage } from '../lib/errors';
import { ALLOW_LOOPBACK_HTTP } from '../lib/runtime';
import { pinServer, pinnedServer, saveLastServer, unpinServer } from '../lib/session';
import { useSession, type Me } from '../lib/session-context';
import { secureStore } from '../lib/storage';
import { base, colors, space } from '../lib/theme';

type Step =
  | { kind: 'email' }
  | { kind: 'confirm'; domain: string; server: ServerConfig }
  | { kind: 'credentials'; domain: string; server: ServerConfig };

const t = strings.signIn;

export default function SignInScreen() {
  const session = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'email' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Coming back from the manual server screen: use what it pinned.
  useFocusEffect(
    useCallback(() => {
      if (step.kind !== 'email') return;
      const domain = emailDomain(email);
      if (!domain) return;
      void pinnedServer(secureStore, domain, { allowLoopbackHttp: ALLOW_LOOPBACK_HTTP }).then(
        (server) => {
          if (server) {
            setError(null);
            setStep({ kind: 'credentials', domain, server });
          }
        },
      );
    }, [email, step.kind]),
  );

  if (session.state.status === 'signedIn') return <Redirect href="/(tabs)/feed" />;

  const continueWithEmail = async () => {
    setError(null);
    setInfo(null);
    const domain = emailDomain(email);
    if (!domain) {
      setError(t.discoveryFailed['bad_email'] ?? strings.errors.generic);
      return;
    }
    setBusy(true);
    try {
      const pinned = await pinnedServer(secureStore, domain, {
        allowLoopbackHttp: ALLOW_LOOPBACK_HTTP,
      });
      if (pinned) {
        setStep({ kind: 'credentials', domain, server: pinned });
        return;
      }
      const result = await discoverServer(email, { fetch, allowLoopbackHttp: ALLOW_LOOPBACK_HTTP });
      if (result.ok) setStep({ kind: 'confirm', domain, server: result.server });
      else setError(t.discoveryFailed[result.reason] ?? strings.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const confirmServer = async (domain: string, server: ServerConfig) => {
    await pinServer(secureStore, domain, server);
    await saveLastServer(secureStore, server);
    setStep({ kind: 'credentials', domain, server });
  };

  const changeServer = async (domain: string) => {
    await unpinServer(secureStore, domain);
    setPassword('');
    setStep({ kind: 'email' });
  };

  const signInWithPassword = async (server: ServerConfig) => {
    setError(null);
    setBusy(true);
    try {
      const api = createApi({ apiUrl: server.apiUrl });
      const result = await api.POST('/v1/auth/login', { body: { email: email.trim(), password } });
      const message = errorMessage(result);
      if (message) {
        setError(message);
        return;
      }
      const secret = (result.data as { sessionToken?: string } | undefined)?.sessionToken;
      if (!secret || !result.data) {
        setError(strings.errors.generic);
        return;
      }
      setPassword('');
      await session.signIn(server, secret, result.data as Me);
      router.replace('/(tabs)/feed');
    } catch {
      setError(strings.errors.offline);
    } finally {
      setBusy(false);
    }
  };

  const requestMagicLink = async (server: ServerConfig) => {
    setError(null);
    setBusy(true);
    try {
      const api = createApi({ apiUrl: server.apiUrl });
      const result = await api.POST('/v1/auth/magic-link', { body: { email: email.trim() } });
      const message = errorMessage(result);
      if (message) setError(message);
      else setInfo(t.magicSent);
    } catch {
      setError(strings.errors.offline);
    } finally {
      setBusy(false);
    }
  };

  const host = (url: string) => new URL(url).host;

  return (
    <KeyboardAvoidingView
      style={base.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={base.pad} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={base.title}>
          {t.title}
        </Text>
        <Text style={base.muted}>{strings.tagline}</Text>
        <Notice text={session.notice} kind="error" />
        <Notice text={error} kind="error" />
        <Notice text={info} />

        {step.kind === 'email' && (
          <View style={base.card}>
            <Text style={base.label} nativeID="email-label">
              {t.emailLabel}
            </Text>
            <TextInput
              accessibilityLabel={t.emailLabel}
              accessibilityLabelledBy="email-label"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              inputMode="email"
              keyboardType="email-address"
              placeholder={t.emailPlaceholder}
              placeholderTextColor={colors.muted}
              returnKeyType="next"
              onSubmitEditing={() => void continueWithEmail()}
              style={base.input}
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                session.clearNotice();
              }}
            />
            <Button label={t.continueButton} onPress={() => void continueWithEmail()} busy={busy} />
            <Button
              label={t.manualServer}
              variant="link"
              onPress={() =>
                router.push({ pathname: '/server', params: { domain: emailDomain(email) ?? '' } })
              }
            />
          </View>
        )}

        {step.kind === 'confirm' && (
          <View style={base.card}>
            <Text accessibilityRole="header" style={base.heading}>
              {t.confirmTitle}
            </Text>
            <Text style={base.body}>{t.confirmBody(host(step.server.apiUrl), step.domain)}</Text>
            {hostRelation(step.domain, step.server.apiUrl) === 'other' && (
              <Notice
                kind="error"
                text={`${host(step.server.apiUrl)} is not part of ${step.domain}. This can be legitimate for a hosted service, but check with your IT team before signing in.`}
              />
            )}
            <View style={base.row}>
              <Button
                label={strings.common.cancel}
                variant="secondary"
                onPress={() => setStep({ kind: 'email' })}
              />
              <Button
                label={t.confirmButton}
                variant={
                  hostRelation(step.domain, step.server.apiUrl) === 'other'
                    ? 'secondary'
                    : 'primary'
                }
                onPress={() => void confirmServer(step.domain, step.server)}
              />
            </View>
          </View>
        )}

        {step.kind === 'credentials' && (
          <View style={base.card}>
            <Text style={base.muted}>{email.trim()}</Text>
            <Text style={base.muted}>
              {t.serverLabel}: {host(step.server.apiUrl)}
            </Text>
            <Text style={base.label} nativeID="password-label">
              {t.passwordLabel}
            </Text>
            <TextInput
              accessibilityLabel={t.passwordLabel}
              accessibilityLabelledBy="password-label"
              autoCapitalize="none"
              autoComplete="current-password"
              secureTextEntry
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void signInWithPassword(step.server)}
              style={base.input}
              value={password}
              onChangeText={setPassword}
            />
            <Button
              label={t.submit}
              onPress={() => void signInWithPassword(step.server)}
              busy={busy}
              disabled={password.length === 0}
            />
            <Button
              label={t.magicLink}
              variant="secondary"
              onPress={() => void requestMagicLink(step.server)}
              disabled={busy}
            />
            <Button
              label={t.changeServer}
              variant="link"
              onPress={() => void changeServer(step.domain)}
            />
          </View>
        )}
        <Text style={[base.muted, { marginTop: space.xl }]}>{strings.sourceLink}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
