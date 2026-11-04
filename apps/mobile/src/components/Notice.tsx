// SPDX-License-Identifier: Apache-2.0
import { StyleSheet, Text, View } from 'react-native';
import { colors, space } from '../lib/theme';

/** Status or error text announced to assistive technology when it appears. */
export function Notice(props: { text: string | null; kind?: 'info' | 'error' }) {
  if (!props.text) return null;
  const error = props.kind === 'error';
  return (
    <View
      accessibilityRole={error ? 'alert' : 'text'}
      accessibilityLiveRegion="polite"
      style={[styles.box, error ? styles.error : styles.info]}
    >
      <Text style={[styles.text, error ? styles.errorText : null]}>{props.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 8, padding: space.md, borderWidth: 1 },
  info: { backgroundColor: colors.surface, borderColor: colors.border },
  error: { backgroundColor: '#fff4f4', borderColor: colors.danger },
  text: { fontSize: 15, color: colors.text, lineHeight: 21 },
  errorText: { color: colors.danger },
});
