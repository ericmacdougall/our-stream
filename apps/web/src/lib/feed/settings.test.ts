// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FEED_SETTINGS,
  feedSettingsReducer,
  loadFeedSettings,
  saveFeedSettings,
} from './settings.js';

describe('feedSettingsReducer', () => {
  it('toggles captions and mute independently', () => {
    const s1 = feedSettingsReducer(DEFAULT_FEED_SETTINGS, { type: 'toggleCaptions' });
    expect(s1.captions).toBe(false);
    expect(s1.muted).toBe(true);
    const s2 = feedSettingsReducer(s1, { type: 'toggleMute' });
    expect(s2.muted).toBe(false);
    expect(s2.captions).toBe(false);
    expect(feedSettingsReducer(s2, { type: 'toggleCaptions' }).captions).toBe(true);
  });
  it('sets shortcut and auto-advance preferences explicitly', () => {
    const s = feedSettingsReducer(DEFAULT_FEED_SETTINGS, {
      type: 'setSingleKeyShortcuts',
      value: false,
    });
    expect(s.singleKeyShortcuts).toBe(false);
    expect(feedSettingsReducer(s, { type: 'setAutoAdvance', value: false }).autoAdvance).toBe(
      false,
    );
  });
  it('hydrates only known boolean keys and never an unmuted state', () => {
    const s = feedSettingsReducer(DEFAULT_FEED_SETTINGS, {
      type: 'hydrate',
      value: { captions: false, muted: false, autoAdvance: 'yes' } as never,
    });
    expect(s.captions).toBe(false);
    expect(s.muted).toBe(true);
    expect(s.autoAdvance).toBe(true);
  });
});

describe('storage', () => {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });
  it('round-trips persisted keys and drops mute', () => {
    vi.stubGlobal('localStorage', fakeStorage);
    saveFeedSettings({ ...DEFAULT_FEED_SETTINGS, captions: false, muted: false });
    expect(loadFeedSettings()).toEqual({
      captions: false,
      singleKeyShortcuts: true,
      autoAdvance: true,
    });
  });
  it('survives corrupt storage', () => {
    vi.stubGlobal('localStorage', { ...fakeStorage, getItem: () => '{not json' });
    expect(loadFeedSettings()).toEqual({});
  });
});
