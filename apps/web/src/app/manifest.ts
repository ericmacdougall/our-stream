// SPDX-License-Identifier: AGPL-3.0-only
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'our-stream',
    short_name: 'our-stream',
    description: 'Knowledge streams for teams',
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f7f5',
    theme_color: '#1f6f5f',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
