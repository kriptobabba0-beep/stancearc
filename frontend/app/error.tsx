'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { buttonClass } from '@/components/ui/Button';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
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
        <p className="mt-2 text-sm text-ink-soft">{error.message}</p>
        <button type="button" onClick={() => reset()} className={buttonClass('danger', 'md', 'mt-4')}>
          Try again
        </button>
      </div>
    </div>
  );
}
