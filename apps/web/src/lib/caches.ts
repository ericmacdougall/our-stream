// SPDX-License-Identifier: AGPL-3.0-only
// ADR-0004: the service worker's caches are dropped on logout and whenever the server epochs move,
// so nothing cached locally can outlive a revocation or retraction.
export async function clearAllCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // CacheStorage can be unavailable (private mode, insecure context); nothing to clear then.
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.active?.postMessage({ type: 'CLEAR_CACHES' });
  } catch {
    // No service worker registered.
  }
}
