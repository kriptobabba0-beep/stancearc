'use client';

// components/arena/MarketContextCard.tsx — the Arena LEFT column ("Current Round"). A HUD panel with
// the round's schedule/rule rows + the live per-side depth bar. Every value is REAL (derived from the
// active market's EpochView), so the mockup's "1 day / 12h / 2h TWAP / ±1.5%" become the actual
// on-chain schedule and band (e.g. 10 min / 5 min / Pyth spot / ±0.20%).
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { ArenaPanel } from '@/components/arena/ArenaPanel';
import { SideDepthBars } from '@/components/arena/SideDepthBars';
import { LivePositionStatus } from '@/components/arena/LivePositionStatus';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV3Market } from '@/lib/markets';
import { Skeleton } from '@/components/ui/Skeleton';
import { Calendar, Clock, Activity, RangeIcon, Info } from '@/components/ui/icons';
import { formatDuration } from '@/lib/arena';
import { formatBps } from '@/lib/format';
import type { ReactNode } from 'react';

function MetaRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-4 lg:py-5">
      {/* Outlined square tile (the reference's icon chips are bordered, not filled). */}
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-muted/40 text-ink-muted">
        {icon}
      </span>
      <span className="flex-1 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted">
        {label}
      </span>
      <span className="font-mono text-sm font-semibold tnum text-ink">{value}</span>
    </div>
  );
}

export function MarketContextCard() {
  const { data: epoch, isLoading } = useCurrentEpoch();
  const v3 = isV3Market(useActiveMarket());

  if (isLoading || !epoch) {
    return (
      <ArenaPanel joint="right" className="flex h-full flex-col px-6 py-6">
        <div className="kicker font-mono">Market context</div>
        <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">Current Round</h2>
        <Skeleton className="mt-5 h-64 w-full" />
      </ArenaPanel>
    );
  }

  const epochLength = epoch.endTime - epoch.startTime;
  const entryWindow = epoch.entryCloseTime - epoch.entryOpenTime;

  return (
    <ArenaPanel joint="right" className="flex h-full flex-col px-6 py-6">
      <div className="kicker font-mono">Market context</div>
      <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">Current Round</h2>

      {/* Rows spread evenly through the stretched middle (no single dead void). Their
          positions stay put across market switches because everything below has CONSTANT
          height — the status footnote reserves two lines (LivePositionStatus) so a longer
          note can't lift this whole bottom-anchored region. */}
      <div className="mt-2 flex flex-1 flex-col justify-evenly divide-y divide-line">
        <MetaRow icon={<Calendar className="h-4 w-4" />} label="Epoch length" value={formatDuration(epochLength)} />
        <MetaRow icon={<Clock className="h-4 w-4" />} label="Entry window" value={formatDuration(entryWindow)} />
        <MetaRow icon={<Activity className="h-4 w-4" />} label="Settlement source" value="Pyth oracle" />
        <MetaRow icon={<RangeIcon className="h-4 w-4" />} label="Market view band" value={`±${formatBps(epoch.bandBps)}`} />
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <div className="mb-3 flex items-center gap-1.5">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted">
            {v3 ? 'Live position status' : 'Side depth (pre-entry)'}
          </span>
          <span
            title={
              v3
                ? 'How many active positions would qualify right now, each judged against its own entry reference price vs the live market price.'
                : "Each side's share of the live staked depth (range-normalized liquidity) this epoch."
            }
            className="text-ink-faint"
          >
            <Info className="h-3.5 w-3.5" />
          </span>
        </div>
        {v3 ? (
          <LivePositionStatus epochId={epoch.epochId} bandBps={epoch.bandBps} />
        ) : (
          <SideDepthBars sideContribution6={epoch.sideContribution6} />
        )}
      </div>
    </ArenaPanel>
  );
}
