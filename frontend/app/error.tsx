'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { buttonClass } from '@/components/ui/Button';
import { isStaleChunkError, reloadIfStaleChunk } from '@/lib/staleChunk';

export default function Error({
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
    // Report to Sentry when NEXT_PUBLIC_SENTRY_DSN is set; otherwise no-op.
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <div
        role="alert"
        className="rounded-2xl border border-side-down/30 bg-side-down-soft p-6 shadow-card"
      >
        <h2 className="font-display text-lg font-semibold text-ink">Something went wrong</h2>
        <p className="mt-2 text-sm text-ink-soft">
          {isStaleChunkError(error)
            ? 'The app was updated while this page was open. Reloading picks up the new version.'
            : error.message}
        </p>
        <button type="button" onClick={() => (isStaleChunkError(error) ? window.location.reload() : reset())} className={buttonClass('danger', 'md', 'mt-4')}>
          Try again
        </button>
      </div>
    </div>
  );
}
