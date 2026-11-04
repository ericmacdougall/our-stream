// SPDX-License-Identifier: Apache-2.0
import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { strings } from '../i18n';
import { useSession } from '../lib/session-context';
import { base, colors } from '../lib/theme';

export default function Index() {
  const { state } = useSession();
  if (state.status === 'loading') {
    return (
      <View style={[base.page, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator accessibilityLabel={strings.common.loading} color={colors.accent} />
      </View>
    );
  }
  return <Redirect href={state.status === 'signedIn' ? '/(tabs)/feed' : '/sign-in'} />;
}
