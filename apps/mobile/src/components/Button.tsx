// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors, space, TARGET } from '../lib/theme';

type Variant = 'primary' | 'secondary' | 'link' | 'danger';

export function Button(props: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  /** Spoken label when the visible text is not enough (icons, counts). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const variant = props.variant ?? 'primary';
  const disabled = props.disabled || props.busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: !!disabled, selected: props.selected, busy: props.busy }}
      disabled={disabled}
      onPress={props.onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && styles.pressed,
        disabled && styles.disabled,
        props.style,
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={variant === 'primary' ? colors.onAccent : colors.accent} />
      ) : (
        (props.children ?? (
          <Text
            style={[
              styles.text,
              variant === 'primary' ? styles.textOnAccent : null,
              variant === 'danger' ? styles.textDanger : null,
            ]}
          >
            {props.label}
          </Text>
        ))
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: TARGET,
    minWidth: TARGET,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  link: { backgroundColor: 'transparent', paddingHorizontal: space.sm },
  danger: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.danger },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
  text: { fontSize: 16, fontWeight: '600', color: colors.accent },
  textOnAccent: { color: colors.onAccent },
  textDanger: { color: colors.danger },
});
