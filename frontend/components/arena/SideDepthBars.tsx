'use client';

// components/arena/SideDepthBars.tsx - the left panel's "Side depth" widget: a single horizontal bar
// split into UP / DOWN / RANGE segments sized by each side's share of the live staked depth
// (epoch.sideContribution6), with the % inside each segment and a colour-coded label beneath. Real
// data - sideContribution6 is the contract's per-side range-normalized liquidity. Before any stakes
// land (total = 0) it shows three equal placeholder segments and an honest "awaiting stakes" note.
import { Side } from '@/lib/types';
import { SIDE_LABELS } from '@/lib/side';
import { ARENA_SIDES, SIDE_HEX, SIDE_TEXT } from '@/components/arena/sides';

export function SideDepthBars({
  sideContribution6,
}: {
  sideContribution6: readonly [bigint, bigint, bigint, bigint];
}) {
  const total = ARENA_SIDES.reduce((sum, s) => sum + sideContribution6[s], 0n);
  const hasDepth = total > 0n;

  // Share as a 2dp percent (display-only ratio; not money math). Equal split as a placeholder pre-stakes.
  const pct = (s: Side): number =>
    hasDepth ? Number((sideContribution6[s] * 10000n) / total) / 100 : 100 / 3;

  return (
    <div className="space-y-2.5">
      {/* Segmented bar - each side's width is its share; the % sits inside the segment. */}
      <div className="flex h-9 w-full overflow-hidden rounded-lg bg-surface-inset">
        {ARENA_SIDES.map((s) => {
          const share = pct(s);
          return (
            <div
              key={s}
              className="flex min-w-0 items-center justify-center text-[12px] font-semibold tnum text-white/95"
              style={{
                flexGrow: Math.max(share, 0.5),
                flexBasis: 0,
                backgroundColor: hasDepth ? SIDE_HEX[s] : 'transparent',
              }}
            >
              {hasDepth && share >= 9 ? `${Math.round(share)}%` : ''}
            </div>
          );
        })}
      </div>

      {/* Labels under their segments (same flex-grow so they line up with the bar). */}
      <div className="flex w-full">
        {ARENA_SIDES.map((s) => (
          <div
            key={s}
            className={`min-w-0 text-center text-[12px] font-semibold ${SIDE_TEXT[s]}`}
            style={{ flexGrow: Math.max(pct(s), 0.5), flexBasis: 0 }}
          >
            {SIDE_LABELS[s]}
          </div>
        ))}
      </div>

      <p className="text-[11px] text-ink-faint">
        {hasDepth
          ? 'Percent of total potential position size.'
          : 'No staked depth yet - shares appear once positions are staked this epoch.'}
      </p>
    </div>
  );
}
