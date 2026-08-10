'use client';

import { useChainTime } from '@/hooks/useChainTime';
import { cn } from '@/lib/cn';

interface CountdownProps {
  /** Unix timestamp (seconds, bigint) — the target the countdown counts down to. */
  target: bigint;
  /** Extra classes merged onto the span (e.g. text-brand for the red modal countdown). */
  className?: string;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Displays a live countdown to `target` using chain-time (not the local clock). */
export function Countdown({ target, className }: CountdownProps) {
  const { now } = useChainTime();
  const remaining = Number(target) - Number(now);

  if (remaining <= 0) {
    return (
      <span data-testid="countdown" className={cn('font-mono tnum font-medium text-ink-faint', className)}>
        00:00:00
      </span>
    );
  }

  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;

  return (
    // Colour lives in the default arm so a caller's text-* class genuinely overrides it (plain clsx
    // concat would otherwise leave both classes and let the stylesheet order win).
    <span data-testid="countdown" className={cn('font-mono tnum font-semibold', className ?? 'text-ink')}>
      {pad2(h)}:{pad2(m)}:{pad2(s)}
    </span>
  );
}
