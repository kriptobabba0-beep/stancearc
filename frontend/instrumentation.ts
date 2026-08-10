// Next.js instrumentation hook — initialises Sentry on the server/edge runtimes.
// The experimental.instrumentationHook flag in next.config.mjs enables this for Next.js 14.
// (Next.js 15+ enables it by default.)

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}
