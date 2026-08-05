import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-20 sm:px-6">
      <span className="kicker">404</span>
      <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
        Page not found
      </h2>
      <p className="mt-3 text-sm text-ink-soft">
        <Link href="/" className="font-medium text-brand hover:text-brand-hover">
          ← Back to dashboard
        </Link>
      </p>
    </div>
  );
}
