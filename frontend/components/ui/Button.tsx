'use client';

import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './icons';
import { Stars } from './Stars';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md' | 'lg';

/*
 * Button variants. primary + secondary render the peach "shooting-star" CTA - buttonClass routes them
 * through STAR_BASE + .star-btn (see globals.css), so the map below is read ONLY for the other three:
 *  - primary  : peach #fec195 solid CTA (.star-btn) - handled in buttonClass, not this map
 *  - secondary: peach outline that fills on hover (.star-btn--secondary) - handled in buttonClass
 *  - subtle   : neutral muted rect for not-yet-actionable CTAs ("Enter an amount")
 *  - ghost    : transparent, grey ink, light hover fill
 *  - danger   : red rect + white text
 */
const VARIANTS: Record<Variant, string> = {
  // Unused - buttonClass returns the peach STAR_BASE for these two before it ever reads VARIANTS.
  primary: '',
  secondary: '',
  ghost: 'text-ink-soft hover:bg-surface-muted',
  danger: 'bg-side-down text-white hover:brightness-95 active:translate-y-px',
  subtle: 'border border-line bg-surface-muted text-ink-muted',
};

const SIZES: Record<Size, string> = {
  sm: 'h-9 gap-1.5 px-4 text-[13px]',
  md: 'h-11 gap-2 px-5 text-sm',
  lg: 'h-12 gap-2 px-6 text-sm',
};

// ghost / danger / subtle keep the original base. primary + secondary render the red shooting-star CTA
// (they're identical - the one button): the .star-btn class (globals.css) owns their fill / border /
// radius / hover-flip / glow / disabled state, so for those two we drop the rounded-xl, transition,
// colour and disabled utilities and keep only the layout (flex + size). Add <Stars /> (components/ui/
// Stars) as the button's last child for the six fly-out sparkles.
const LEGACY_BASE =
  'inline-flex cursor-pointer items-center justify-center rounded-xl font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50';
const STAR_BASE =
  'star-btn inline-flex items-center justify-center font-semibold focus-visible:outline-none';

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', className?: string) {
  if (variant === 'primary' || variant === 'secondary') {
    return cn(STAR_BASE, SIZES[size], className);
  }
  return cn(LEGACY_BASE, VARIANTS[variant], SIZES[size], className);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  leftIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={buttonClass(variant, size, className)}
      {...props}
    >
      {loading ? <Spinner className="h-4 w-4" /> : leftIcon}
      {children}
      {(variant === 'primary' || variant === 'secondary') && <Stars />}
    </button>
  );
}
