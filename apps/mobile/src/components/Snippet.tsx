// SPDX-License-Identifier: Apache-2.0
import { StyleSheet, Text } from 'react-native';
import { snippetSegments } from '../lib/snippets';
import { colors } from '../lib/theme';

/** Plain-text snippet with highlighted matches (ranges are UTF-16 offsets from the API). */
export function Snippet(props: { text: string; ranges: ReadonlyArray<readonly [number, number]> }) {
  return (
    <Text style={styles.text}>
      {snippetSegments(props.text, props.ranges).map((s, i) => (
        <Text key={i} style={s.highlight ? styles.hit : undefined}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 15, color: colors.text, lineHeight: 21 },
  hit: { fontWeight: '700', backgroundColor: '#fff2b8' },
});
