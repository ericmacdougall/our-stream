// SPDX-License-Identifier: Apache-2.0
// Storage backends. Secrets (session, pinned servers) go to expo-secure-store; bookkeeping
// (engagement sessions) goes to AsyncStorage. SecureStore exists only on Android, iOS and tvOS, so
// the web target (used for development click tests, not distribution) keeps secrets in
// sessionStorage, which dies with the tab.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { memoryStore, type KeyValueStore } from './kv';

function webSessionStore(): KeyValueStore {
  const ss = typeof sessionStorage === 'undefined' ? null : sessionStorage;
  if (!ss) return memoryStore();
  return {
    async get(key) {
      return ss.getItem(key);
    },
    async set(key, value) {
      ss.setItem(key, value);
    },
    async remove(key) {
      ss.removeItem(key);
    },
  };
}

export const secureStore: KeyValueStore =
  Platform.OS === 'web'
    ? webSessionStore()
    : {
        get: (key) => SecureStore.getItemAsync(key),
        set: (key, value) =>
          SecureStore.setItemAsync(key, value, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          }),
        remove: (key) => SecureStore.deleteItemAsync(key),
      };

export const plainStore: KeyValueStore = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};
