// SPDX-License-Identifier: AGPL-3.0-only
// Keyboard mapping for the feed. Arrow keys and Space always work; J/K/C/M are single-character
// shortcuts that the viewer can switch off (WCAG 2.1.4 Character Key Shortcuts).
export type FeedKeyAction = 'next' | 'prev' | 'togglePlay' | 'toggleCaptions' | 'toggleMute';

export interface KeyInput {
  key: string;
  /** Lower-cased tag name of the event target, e.g. 'input', 'button', 'video'. */
  targetTag: string;
  isEditable?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

const FORM_TAGS = new Set(['input', 'textarea', 'select']);
const ACTIVATABLE = new Set(['button', 'a', 'summary']);

export function feedKeyAction(
  input: KeyInput,
  options: { singleKeyShortcuts: boolean },
): FeedKeyAction | null {
  if (input.altKey || input.ctrlKey || input.metaKey) return null;
  if (input.isEditable || FORM_TAGS.has(input.targetTag)) return null;

  switch (input.key) {
    case 'ArrowDown':
    case 'PageDown':
      return 'next';
    case 'ArrowUp':
    case 'PageUp':
      return 'prev';
    case ' ':
    case 'Spacebar':
      // A focused button or link activates on Space; do not also toggle playback.
      return ACTIVATABLE.has(input.targetTag) ? null : 'togglePlay';
  }

  if (!options.singleKeyShortcuts) return null;
  switch (input.key.toLowerCase()) {
    case 'j':
      return 'next';
    case 'k':
      return 'prev';
    case 'c':
      return 'toggleCaptions';
    case 'm':
      return 'toggleMute';
    default:
      return null;
  }
}

/** Clamps the next active index; returns the same index at the edges. */
export function stepIndex(current: number, action: 'next' | 'prev', count: number): number {
  if (count <= 0) return 0;
  const next = action === 'next' ? current + 1 : current - 1;
  return Math.min(Math.max(next, 0), count - 1);
}
