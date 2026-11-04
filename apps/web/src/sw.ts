// SPDX-License-Identifier: AGPL-3.0-only
// Service worker (Serwist). Runtime caching is limited to same-origin static assets; nothing under
// /api or /media is ever cached, and the page can ask us to drop every cache (ADR-0004).
import { CacheFirst, Serwist, StaleWhileRevalidate } from 'serwist';
import { isCacheableStatic } from './lib/sw-rules';

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: [],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    {
      matcher: ({ url, sameOrigin }) =>
        sameOrigin &&
        isCacheableStatic(url, self.location.origin) &&
        url.pathname.startsWith('/_next/static/'),
      handler: new CacheFirst({ cacheName: 'next-static' }),
    },
    {
      matcher: ({ url, sameOrigin }) =>
        sameOrigin &&
        isCacheableStatic(url, self.location.origin) &&
        !url.pathname.startsWith('/_next/static/'),
      handler: new StaleWhileRevalidate({ cacheName: 'static-assets' }),
    },
  ],
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'CLEAR_CACHES') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

serwist.addEventListeners();
