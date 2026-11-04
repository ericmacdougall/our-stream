// SPDX-License-Identifier: AGPL-3.0-only
// Viewer preferences for the feed. These are device-local UI settings (not personalised content), so
// localStorage is acceptable; every read and write is guarded.
export interface FeedSettings {
  /** Show the WebVTT captions track. */
  captions: boolean;
  /** Autoplay is always muted (WCAG 1.4.2); the viewer may unmute for the session. */
  muted: boolean;
  /** J/K/C/M shortcuts (WCAG 2.1.4); arrows and Space always work. */
  singleKeyShortcuts: boolean;
  /** Advance to the next clip when one ends (WCAG 2.2.2 pause control). */
  autoAdvance: boolean;
}

export const DEFAULT_FEED_SETTINGS: FeedSettings = {
  captions: true,
  muted: true,
  singleKeyShortcuts: true,
  autoAdvance: true,
};

export type FeedSettingsAction =
  | { type: 'toggleCaptions' }
  | { type: 'setCaptions'; value: boolean }
  | { type: 'toggleMute' }
  | { type: 'setMuted'; value: boolean }
  | { type: 'setSingleKeyShortcuts'; value: boolean }
  | { type: 'setAutoAdvance'; value: boolean }
  | { type: 'hydrate'; value: Partial<FeedSettings> };

export function feedSettingsReducer(state: FeedSettings, action: FeedSettingsAction): FeedSettings {
  switch (action.type) {
    case 'toggleCaptions':
      return { ...state, captions: !state.captions };
    case 'setCaptions':
      return { ...state, captions: action.value };
    case 'toggleMute':
      return { ...state, muted: !state.muted };
    case 'setMuted':
      return { ...state, muted: action.value };
    case 'setSingleKeyShortcuts':
      return { ...state, singleKeyShortcuts: action.value };
    case 'setAutoAdvance':
      return { ...state, autoAdvance: action.value };
    case 'hydrate':
      return { ...state, ...sanitise(action.value) };
    default:
      return state;
  }
}

const STORAGE_KEY = 'our-stream.feed-settings.v1';

function sanitise(value: unknown): Partial<FeedSettings> {
  if (!value || typeof value !== 'object') return {};
  const out: Partial<FeedSettings> = {};
  const v = value as Record<string, unknown>;
  for (const key of ['captions', 'singleKeyShortcuts', 'autoAdvance'] as const) {
    if (typeof v[key] === 'boolean') out[key] = v[key];
  }
  // Mute is never persisted as "unmuted": every visit starts muted (WCAG 1.4.2).
  return out;
}

export function loadFeedSettings(): Partial<FeedSettings> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? sanitise(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveFeedSettings(settings: FeedSettings): void {
  try {
    const { captions, singleKeyShortcuts, autoAdvance } = settings;
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ captions, singleKeyShortcuts, autoAdvance }),
    );
  } catch {
    // Storage unavailable; settings stay in memory for this page.
  }
}
