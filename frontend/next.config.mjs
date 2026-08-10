import { withSentryConfig } from '@sentry/nextjs';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

// Cloudflare Workers (via @opennextjs/cloudflare): wires the local dev bindings so `next dev` mirrors
// the deployed Worker. No-ops outside `next dev`, so it never affects `next build` / `cf:build`.
initOpenNextCloudflareForDev();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Required for @sentry/nextjs instrumentation.ts on Next.js 14.
  // (Next.js 15+ enables this automatically.)
  experimental: {
    instrumentationHook: true,
  },

  // The Arena page was renamed to Stance. Issue a real 308 server redirect at the routing layer
  // (clean for crawlers/non-JS clients + old shared links) instead of a page-level client redirect.
  async redirects() {
    return [{ source: '/arena', destination: '/stance', permanent: true }];
  },
};

// Sentry's BUILD plugin (withSentryConfig) runs source-map generation plus
// Vercel-specific steps (release/cron detection) that add build time + memory
// and can fail the Vercel deploy — and it is pure overhead until a Sentry
// project is actually configured. So only wrap the build with Sentry when
// SENTRY_AUTH_TOKEN is present. The RUNTIME Sentry (instrumentation*.ts +
// Sentry.init) stays in place and is simply inert without a DSN, so error
// reporting can be switched on later by setting NEXT_PUBLIC_SENTRY_DSN
// (+ SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT to upload source maps) —
// no code change needed.
export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      sourcemaps: { disable: false },
      telemetry: false,
    })
  : nextConfig;
