// components/ui/BouncingLoader.tsx — the app's loading animation: three dots that bounce in sequence
// over a soft crimson ground-shadow, tuned for the near-black canvas. Replaces the old spinner pill.
// The motion lives in globals.css under `.lf-loader` (keyframes lf-bounce / lf-bounce-shadow); the
// markup order is THREE dots then THREE shadows so the nth-child pairing in the CSS lines each shadow
// up under its own dot. (Loader silhouette adapted from a Uiverse loader by mobinkakei.)
import { cn } from '@/lib/cn';

export function BouncingLoader({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-6', className)} role="status" aria-live="polite">
      <div className="lf-loader" aria-hidden="true">
        <div className="lf-circle" />
        <div className="lf-circle" />
        <div className="lf-circle" />
        <div className="lf-shadow" />
        <div className="lf-shadow" />
        <div className="lf-shadow" />
      </div>
      {label ? (
        <p className="font-mono text-[12px] uppercase tracking-[0.18em] text-ink-muted">{label}</p>
      ) : null}
      <span className="sr-only">{label ?? 'Loading'}</span>
    </div>
  );
}
