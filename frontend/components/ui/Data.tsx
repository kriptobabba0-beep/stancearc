'use client';

import { type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A label/value row for the definition-list pattern (mono, tabular value on the right). */
export function DataRow({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 py-2.5', className)}>
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-right font-mono text-sm tnum text-ink">{children}</dd>
    </div>
  );
}

/** A boxed KPI tile: kicker label + large mono value + optional sub-line. */
export function Stat({
  label,
  value,
  sub,
  valueClassName,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  valueClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface-muted px-4 py-3', className)}>
      <div className="kicker">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-lg font-medium leading-tight tnum text-ink',
          valueClassName,
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}
