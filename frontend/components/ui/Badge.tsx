'use client';

import { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'brand' | 'up' | 'down' | 'range' | 'success' | 'warning' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-ink-soft ring-line',
  brand: 'bg-brand-soft text-brand ring-brand-ring',
  up: 'bg-side-up-soft text-side-up ring-side-up-ring',
  down: 'bg-side-down-soft text-side-down ring-side-down-ring',
  range: 'bg-side-range-soft text-side-range ring-side-range-ring',
  success: 'bg-side-up-soft text-side-up ring-side-up-ring',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', dot = false, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
