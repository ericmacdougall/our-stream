// SPDX-License-Identifier: Apache-2.0
// Colour and spacing tokens. Text/background pairs meet WCAG AA (4.5:1) in both schemes.
import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#f7f7f5',
  surface: '#ffffff',
  border: '#d9d9d3',
  text: '#1b1c1a',
  muted: '#55574f',
  accent: '#1f6f5f',
  onAccent: '#ffffff',
  danger: '#9b1c1c',
  video: '#000000',
  scrim: 'rgba(0,0,0,0.55)',
  onVideo: '#ffffff',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
/** Minimum touch target (WCAG 2.5.8 / platform guidance). */
export const TARGET = 44;

export const base = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: space.lg, gap: space.lg },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  heading: { fontSize: 18, fontWeight: '600', color: colors.text },
  body: { fontSize: 16, color: colors.text, lineHeight: 22 },
  muted: { fontSize: 14, color: colors.muted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.sm,
  },
  input: {
    minHeight: TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: space.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  label: { fontSize: 14, fontWeight: '600', color: colors.text },
  error: { color: colors.danger, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
});
