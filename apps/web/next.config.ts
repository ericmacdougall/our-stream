// SPDX-License-Identifier: AGPL-3.0-only
import type { NextConfig } from 'next';

// The browser only ever talks to this origin: /api/* and /media/* are rewritten to the API so the
// session cookie flows same-site and FeedItem.media's relative proxy paths resolve (ADR-0003/0011).
// Rewrites are fixed at build time, so the Docker build passes API_INTERNAL_URL as a build arg.
const apiInternalUrl = (process.env['API_INTERNAL_URL'] ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@our-stream/contracts'],
  async rewrites() {
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
