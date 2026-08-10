// components/arena/sides.ts — Arena-local side visuals. The mockups treat RANGE as a NEUTRAL slate
// (not the app-wide blue), with UP green / DOWN red, so these Arena components use a local palette.
// Hexes use CSS vars for UP/DOWN (theme-flipping) and a fixed slate for RANGE.
import { Side } from '@/lib/types';

export const ARENA_SIDES = [Side.UP, Side.DOWN, Side.RANGE] as const;

/** Fill colour for bars / icons (CSS color strings). */
export const SIDE_HEX: Record<number, string> = {
  [Side.UP]: 'rgb(var(--c-side-up))',
  [Side.DOWN]: 'rgb(var(--c-side-down))',
  [Side.RANGE]: 'rgb(124 136 153)', // slate — RANGE is the neutral outcome in the mockups
};

/** Tailwind text-colour token per side. */
export const SIDE_TEXT: Record<number, string> = {
  [Side.UP]: 'text-side-up',
  [Side.DOWN]: 'text-side-down',
  [Side.RANGE]: 'text-ink-soft',
};

/** One-line meaning of each call, shown under the side cards (matches the mockup copy). */
export const SIDE_DESC: Record<number, string> = {
  [Side.UP]: 'Final price above your upper threshold',
  [Side.DOWN]: 'Final price below your lower threshold',
  [Side.RANGE]: 'Final price inside your entry band',
};
