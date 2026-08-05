'use client';

// components/ui/StatRow.tsx - the Uniswap "Explore" stat band: a horizontal row of stat cells
// (small grey label · big bold number · optional green/red delta), separated by vertical HAIRLINE
// dividers and wrapped in a white rounded card. On mobile it wraps to a 2-up grid (the vertical
// dividers degrade to a hairline-grid) so the numbers never crush. Pure presentational - values are
// formatted by the caller (mono/tabular for numerics). Mirrors uniswap-explore.png's top row.
import { type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface StatCellData {
  /** Small uppercase metadata label (the kicker pattern). */
  label: ReactNode;
  /** The big bold figure. Caller formats (mono/tnum for numbers). */
  value: ReactNode;
  /** Optional signed change shown as a green (up) / red (down) / muted (flat) pill-less delta. */
  delta?: { text: ReactNode; dir: 'up' | 'down' | 'flat' };
  /** Optional sub-line under the value (e.g. a unit or context). */
  sub?: ReactNode;
  /** Tint the value (e.g. brand for the pot, side-up/down for P&L). */
  valueClassName?: string;
}

const DELTA_TONE: Record<'up' | 'down' | 'flat', string> = {
  up: 'text-side-up',
  down: 'text-side-down',
  flat: 'text-ink-muted',
};

/** A single stat cell: label, big value, optional delta + sub-line. */
function StatCell({ label, value, delta, sub, valueClassName }: StatCellData) {
  return (
    <div className="min-w-0 flex-1 px-5 py-4">
      <div className="kicker">{label}</div>
      <div
        className={cn(
          'mt-1.5 font-mono text-2xl font-semibold leading-none tnum text-ink',
          valueClassName,
        )}
      >
        {value}
      </div>
      {delta && (
        <div className={cn('mt-1.5 flex items-center gap-1 text-xs font-medium', DELTA_TONE[delta.dir])}>
          {delta.dir !== 'flat' && (
            <span aria-hidden="true">{delta.dir === 'up' ? '▲' : '▼'}</span>
          )}
          <span className="tnum">{delta.text}</span>
        </div>
      )}
      {sub && <div className="mt-1 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

/**
 * The full stat band. White rounded-3xl card; cells split by vertical hairlines on >=sm and by a
 * hairline grid when wrapped on mobile. `data-testid` is forwarded to the band for test targeting.
 */
export function StatRow({
  stats,
  className,
  'data-testid': testId,
}: {
  stats: StatCellData[];
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <div className="hud-col">
      <div
        data-testid={testId}
        className={cn(
          // The Arena HUD frame (chamfered octagon; ext 0 + element clip - see ui/Card.tsx).
          'hud-panel [--hud-ext:0px] [clip-path:var(--hud-clip)]',
          // Mobile: a 2-up grid split by a hairline grid. >=sm: a single flex row split by vertical
          // hairlines (the reference's top band). divide-* targets the direct StatCell children.
          'grid grid-cols-2 divide-x divide-y divide-line',
          'sm:flex sm:divide-y-0',
          className,
        )}
      >
        {stats.map((s, i) => (
          <StatCell key={i} {...s} />
        ))}
      </div>
    </div>
  );
}
