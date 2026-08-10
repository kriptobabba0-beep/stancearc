'use client';

// global-error.tsx catches errors thrown in the root layout (layout.tsx).
// It must render its own <html>/<body> because the root layout is unavailable.
// Errors are forwarded to Sentry when NEXT_PUBLIC_SENTRY_DSN is set.

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { isStaleChunkError, reloadIfStaleChunk } from '@/lib/staleChunk';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // A stale chunk means the page is running against a build that no longer exists. Reload rather
    // than report: reset() would just ask for the same missing file again.
    if (reloadIfStaleChunk(error)) return;
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-white font-sans text-gray-900 antialiased">
        <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-6 shadow">
            <h2 className="text-lg font-semibold text-gray-900">Something went wrong</h2>
            <p className="mt-2 text-sm text-gray-600">
              {isStaleChunkError(error)
                ? 'The app was updated while this page was open. Reloading picks up the new version.'
                : error.message}
            </p>
            <button
              type="button"
              onClick={() => (isStaleChunkError(error) ? window.location.reload() : reset())}
              className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
