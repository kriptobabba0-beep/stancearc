// app/manifest.ts — web app manifest (served at /manifest.webmanifest, linked automatically).
// Gives Android/desktop "install" surfaces the real Limen mark and dark-canvas chrome.
import type { MetadataRoute } from 'next';
import { SITE_NAME, SITE_DESCRIPTION } from '@/lib/seo';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: 'Limen',
    description: SITE_DESCRIPTION,
    start_url: '/',
    display: 'standalone',
    // The app's dark canvas (globals.css --c-canvas dark = 10 10 12).
    background_color: '#0A0A0C',
    theme_color: '#0A0A0C',
    icons: [
      { src: '/brand/limen-mark-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/limen-mark-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
