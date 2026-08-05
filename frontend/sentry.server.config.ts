import * as Sentry from '@sentry/nextjs';

// Initialise Sentry on the Node.js server runtime (Server Components, Route
// Handlers, etc.).  Without a DSN this is inert and sends nothing.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  debug: false,
});
