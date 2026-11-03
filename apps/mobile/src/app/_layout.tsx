// SPDX-License-Identifier: Apache-2.0
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerTitle: 'our-stream' }} />
      <StatusBar style="auto" />
    </>
  );
}
