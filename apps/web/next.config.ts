// SPDX-License-Identifier: AGPL-3.0-only
import type { NextConfig } from 'next';

// The browser only ever talks to this origin: /api/* and /media/* are rewritten to the API so the
// session cookie flows same-site and FeedItem.media's relative proxy paths resolve (ADR-0003/0011).
// Rewrites are fixed at build time, so the Docker build passes API_INTERNAL_URL as a build arg.
// Behind the Caddy edge or the chart's Ingress those paths reach the API before web, so production
// images are built with WEB_PROXY_API=false and carry no rewrite at all: a misrouted request then
// fails closed (404 at web) instead of web becoming an unintended hop to the API.
const apiInternalUrl = (process.env['API_INTERNAL_URL'] ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);
const proxyApi = (process.env['WEB_PROXY_API'] ?? 'true').toLowerCase() !== 'false';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@our-stream/contracts'],
  async rewrites() {
    if (!proxyApi) return [];
    return [
      { source: '/api/:path*', destination: `${apiInternalUrl}/:path*` },
      { source: '/media/:path*', destination: `${apiInternalUrl}/media/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
          // Personalised pages must never be stored by shared caches (ADR-0004).
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      },
      {
        // The service worker script itself must never be served stale (ADR-0004).
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
