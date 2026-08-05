import * as Sentry from '@sentry/nextjs';

// Initialise Sentry on the client side.
// If NEXT_PUBLIC_SENTRY_DSN is not set the call is a no-op (Sentry does
// nothing and sends no requests), so the app works without a Sentry account.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Capture 10 % of traces in production; 100 % locally for easier debugging.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Only send replays on error (0 % session replays to keep free-tier usage low).
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,

  // Do not print debug output in the browser console.
  debug: false,
});

// Required by @sentry/nextjs to instrument client-side navigations.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
