// SPDX-License-Identifier: Apache-2.0
import { Redirect, Tabs } from 'expo-router';
import { Text } from 'react-native';
import { strings } from '../../i18n';
import { useSession } from '../../lib/session-context';
import { colors } from '../../lib/theme';

function Label(props: { label: string; focused: boolean }) {
  return (
    <Text
      style={{
        fontSize: 14,
        fontWeight: props.focused ? '700' : '500',
        color: props.focused ? colors.accent : colors.muted,
      }}
    >
      {props.label}
    </Text>
  );
}

export default function TabsLayout() {
  const { state } = useSession();
  if (state.status === 'loading') return null;
  if (state.status === 'signedOut') return <Redirect href="/sign-in" />;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 64,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="feed"
        options={{
          title: strings.tabs.feed,
          tabBarAccessibilityLabel: strings.tabs.feed,
          tabBarIcon: () => null,
          tabBarLabel: ({ focused }) => <Label label={strings.tabs.feed} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: strings.tabs.search,
          tabBarAccessibilityLabel: strings.tabs.search,
          tabBarIcon: () => null,
          tabBarLabel: ({ focused }) => <Label label={strings.tabs.search} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: strings.tabs.notifications,
          tabBarAccessibilityLabel: strings.tabs.notifications,
          tabBarIcon: () => null,
          tabBarLabel: ({ focused }) => (
            <Label label={strings.tabs.notifications} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
