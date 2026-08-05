import type { Metadata } from 'next';
import { Outfit, Inter, IBM_Plex_Mono } from 'next/font/google';
import { SITE_URL, SITE_NAME, SITE_TITLE, SITE_DESCRIPTION } from '@/lib/seo';
import './globals.css';
import { Providers } from './providers';
import { WrongNetworkBanner } from '@/components/WrongNetworkBanner';
import { NavBar } from '@/components/NavBar';
import { SiteFooter } from '@/components/SiteFooter';
import { RouteChrome } from '@/components/RouteChrome';
import { ThemeScript } from '@/components/ThemeProvider';

const outfit = Outfit({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-outfit',
  display: 'swap',
});
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-inter',
  display: 'swap',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  // Explicit OpenGraph + Twitter so the link preview (Telegram/Discord/X) shows the branded
  // copy reliably instead of falling back to scraped/cached text.
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    url: SITE_URL,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    // STATIC branded card (public/brand/og.png, 1200×630, pre-rendered from the master mark).
    // Deliberately not a next/og ImageResponse route: that runtime 500s on this deploy stack.
    images: [{ url: '/brand/og.png', width: 1200, height: 630, alt: SITE_TITLE }],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ['/brand/og.png'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${outfit.variable} ${inter.variable} ${plexMono.variable}`}
    >
      <head>
        {/* Set the theme class before paint to avoid a light→dark flash (FOUC). */}
        <ThemeScript />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">
        {/* Atmosphere: dot-grid + a faint pink wash near the top (both theme-aware). */}
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-grid" />
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[460px] bg-glow"
        />
        <Providers>
          <WrongNetworkBanner />
          <RouteChrome>
            <NavBar />
          </RouteChrome>
          {children}
        </Providers>
        <RouteChrome>
          <SiteFooter />
        </RouteChrome>
      </body>
    </html>
  );
}
