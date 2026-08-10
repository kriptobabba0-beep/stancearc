'use client';

import { Side } from '@/lib/types';
import { SIDE_LABELS, SIDE_COLORS } from '@/lib/side';

interface SideBarsProps {
  sideContribution6: readonly [bigint, bigint, bigint, bigint];
}

const ROWS: Side[] = [Side.UP, Side.DOWN, Side.RANGE];

// Presentational-only width percentage. NOT money math; ratios are unchanged by the liquidity relabel.
function widthPct(value: bigint, max: bigint): number {
  if (max === 0n) return 0;
  return Number((value * 1000n) / max) / 10; // 1 decimal of precision, display-only
}

/** Render a staked-depth bigint as a plain thousands-separated integer (no currency symbol). */
function formatLiquidity(value: bigint): string {
  // Manual thousands-separator — avoids locale-dependent output in SSR / test environments.
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function SideBars({ sideContribution6 }: SideBarsProps) {
  const max = ROWS.reduce((m, s) => (sideContribution6[s] > m ? sideContribution6[s] : m), 0n);

  return (
    <div className="space-y-3">
      <p className="kicker">Per-side staked depth</p>
      <div className="space-y-3">
        {ROWS.map((s) => (
          <div key={s} data-testid={`bar-${s}`}>
            <div className="flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-2 font-medium text-ink-soft">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SIDE_COLORS[s] }} />
                {SIDE_LABELS[s]}
              </span>
              <span className="font-mono tnum text-ink">
                {formatLiquidity(sideContribution6[s])}
              </span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-inset">
              <div
                className="h-full origin-left animate-bar-grow rounded-full"
                style={{ width: `${widthPct(sideContribution6[s], max)}%`, backgroundColor: SIDE_COLORS[s] }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-faint">
        Staked depth totals only (range-normalized liquidity). Winner &amp; share projections are
        hidden until the epoch settles.
      </p>
    </div>
  );
}
