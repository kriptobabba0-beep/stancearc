'use client';

// components/arena/ArenaPanel.tsx — the Arena "HUD" panel shell + shared CTA helper.
//
// ArenaPanel renders the reference frame (see globals.css `.hud-panel`): an octagon with all four
// corners chamfered, whose edge facing a neighbouring column physically steps OUT into the gutter as
// an interlocking TAB (the `joint` prop picks which edge: the left column joints right, the right
// column joints left, the center joints both). The tab is part of the panel outline itself — border
// and fill follow it. The center panel also renders the glowing crimson bar centered in each gutter
// channel (one bar per gap, shared by the two facing tabs). Bars/tabs exist only at lg+ (3 columns).
//
// arenaButtonClass is the Arena's primary/secondary CTA (glossy crimson rounded-rect — the mockup's
// red buttons), kept LOCAL to the Arena so the rest of the app's pill buttons are untouched.
import { type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function ArenaPanel({
  children,
  className,
  accent = false,
  muted = false,
  sm = false,
  joint,
}: {
  children: ReactNode;
  className?: string;
  accent?: boolean;
  muted?: boolean;
  sm?: boolean;
  /**
   * Which inner edge carries the interlocking tab: 'right' (left column), 'left' (right column),
   * 'both' (center column — also renders the crimson channel bars). Omit for a plain octagon.
   */
  joint?: 'left' | 'right' | 'both';
}) {
  return (
    <div
      className={cn(
        'hud-panel',
        joint === 'right' && 'hud-joint-r',
        joint === 'left' && 'hud-joint-l',
        joint === 'both' && 'hud-joint-lr',
        accent && 'hud-panel-accent',
        muted && 'hud-panel-muted',
        sm && 'hud-panel-sm',
        className,
      )}
    >
      {joint === 'both' && (
        <>
          {/* Crimson bars centered in the two gutter channels (gap-6 = 24px → center at −12px). */}
          <span aria-hidden="true" className="hud-joint-bar hidden lg:block" style={{ left: -13 }} />
          <span aria-hidden="true" className="hud-joint-bar hidden lg:block" style={{ right: -13 }} />
        </>
      )}
      {children}
    </div>
  );
}

/**
 * ArenaModal — the Arena's dialog shell: the SAME chamfered hud-panel frame as the page columns
 * (the reference modals have cut corners, not plain rounded ones) on a dimmed blurred backdrop.
 * The hud border lives on ::before/::after of the OUTER div (which must stay overflow-visible so the
 * 1px edge isn't clipped); content scrolls in an inner area. Escape/backdrop/X all close.
 */
export function ArenaModal({
  open,
  onClose,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Width override on the frame (e.g. "max-w-2xl"); default max-w-lg. */
  className?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className={cn('hud-panel relative w-full', className ?? 'max-w-lg')} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3.5 top-3.5 z-10 grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <div className="max-h-[88vh] overflow-y-auto px-6 py-6">{children}</div>
      </div>
    </div>
  );
}

type ArenaBtnVariant = 'primary' | 'secondary' | 'ghost';

const ARENA_BTN: Record<ArenaBtnVariant, string> = {
  // primary/secondary are unused — arenaButtonClass returns the peach .star-btn for them before it reads
  // this map. Only ghost still flows through here.
  primary: '',
  secondary: '',
  ghost: 'h-10 px-4 text-ink-muted hover:bg-surface-muted hover:text-ink',
};

const ARENA_LEGACY_BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60';
// primary/secondary share the red .star-btn look (see buttonClass + globals.css); ghost is unchanged.
// .star-btn owns fill/border/radius/hover-flip/glow, so we keep only layout + a default h-12 px-5 — and
// we DON'T add that default when the caller already passes its own height (the welcome hero CTAs do), so
// the two heights never fight (cn doesn't dedupe Tailwind classes). Add <Stars/> as the last child for
// the fly-out sparkles.
const ARENA_STAR_BASE =
  'star-btn inline-flex items-center justify-center gap-2 text-sm font-semibold focus-visible:outline-none';

/** Arena CTA classes — red star CTA (primary/secondary) or quiet ghost. */
export function arenaButtonClass(variant: ArenaBtnVariant = 'primary', className?: string) {
  if (variant === 'primary' || variant === 'secondary') {
    const hasHeight = !!className && /\bh-/.test(className);
    return cn(ARENA_STAR_BASE, hasHeight ? undefined : 'h-12 px-5', className);
  }
  return cn(ARENA_LEGACY_BASE, ARENA_BTN[variant], className);
}
