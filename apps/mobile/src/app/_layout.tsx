// SPDX-License-Identifier: Apache-2.0
import * as Linking from 'expo-linking';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { strings } from '../i18n';
import { offerMagicLink } from '../lib/deeplink';
import { SessionProvider } from '../lib/session-context';
import { colors } from '../lib/theme';

function DeepLinks() {
  const url = Linking.useURL();
  const router = useRouter();
  useEffect(() => {
    // The token goes to the memory slot; the magic screen asks before consuming it.
    if (offerMagicLink(url)) router.replace('/magic');
  }, [url, router]);
  return null;
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <DeepLinks />
      <Stack
        screenOptions={{
          headerTitle: strings.appName,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ title: strings.signIn.title }} />
        <Stack.Screen name="server" options={{ title: strings.server.title }} />
        <Stack.Screen name="magic" options={{ title: strings.signIn.title }} />
        <Stack.Screen name="content/[id]/index" options={{ title: strings.feed.title }} />
        <Stack.Screen name="content/[id]/share" options={{ title: strings.share.title }} />
      </Stack>
      <StatusBar style="dark" />
    </SessionProvider>
  );
}
