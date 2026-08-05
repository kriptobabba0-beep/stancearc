'use client';

import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { SectionCard } from '@/components/ui/Card';
import { DataRow } from '@/components/ui/Data';
import { Skeleton } from '@/components/ui/Skeleton';
import { PhaseBadge } from '@/components/PhaseBadge';
import { Countdown } from '@/components/Countdown';
import { MoneyAmount, BaseAmount } from '@/components/MoneyAmount';
import { useActiveMarket } from '@/components/MarketProvider';
import { Activity, ArrowUp, Clock, Trophy } from '@/components/ui/icons';
import { formatBps, formatDeltaBps } from '@/lib/format';
import { potUsd6, formatUsd6, impliedMoveText, priceSymbol } from '@/lib/quant';
import { PhaseView, Side } from '@/lib/types';
import { SIDE_LABELS } from '@/lib/side';
import { cn } from '@/lib/cn';

// Pick the next phase boundary (chain-time target) for the Countdown based on the contract phase.
function boundaryFor(epoch: {
  phase: PhaseView;
  entryCloseTime: bigint;
  startTime: bigint;
  endTime: bigint;
}): { label: string; target: bigint } | null {
  switch (epoch.phase) {
    case PhaseView.EntryOpen:
      return { label: 'Entry closes in', target: epoch.entryCloseTime };
    case PhaseView.Running:
      return { label: 'Epoch ends in', target: epoch.endTime };
    case PhaseView.Idle:
      return { label: 'Entry opens at', target: epoch.startTime };
    default:
      return null; // Settled: no countdown
  }
}

export function EpochPanel() {
  const { data: epoch, isLoading } = useCurrentEpoch();
  const { data: oracle } = useOraclePrice();
  const market = useActiveMarket();
  // Price-pair subtitle reflects the active market's base symbol (strip a leading "W", e.g. WETH->ETH).
  const priceLabel = `${market.baseSymbol.replace(/^W/i, '')} / USD`;

  if (isLoading || !epoch) {
    return (
      <SectionCard kicker="Current epoch" title="Epoch" icon={<Activity className="h-5 w-5" />}>
        <Skeleton className="h-44 w-full" />
      </SectionCard>
    );
  }

  const boundary = boundaryFor(epoch);
  const hasStart = epoch.startPrice18 !== 0n;
  const hasSettle = epoch.settlePrice18 !== 0n;
  const isSettled = epoch.phase === PhaseView.Settled;

  // Quantify the pot: pot tokens × the live oracle price (USDC leg is already USD). 6dp USD value.
  // Honest framing: when the oracle hasn't been read yet (price18==0) only the USDC leg contributes.
  const oraclePrice18 = oracle?.price18 ?? 0n;
  const potUsdValue6 = potUsd6({
    potWETH: epoch.potWETH,
    potUSDC: epoch.potUSDC,
    baseDecimals: market.baseDecimals,
    price18: oraclePrice18,
  });
  // Implied move to win, derived purely from the band (no fabricated odds).
  const sym = priceSymbol(market.baseSymbol);

  return (
    <SectionCard
      kicker="Current epoch"
      title={`Epoch #${epoch.epochId.toString()}`}
      icon={<Activity className="h-5 w-5" />}
      action={<PhaseBadge phase={epoch.phase} />}
    >
      {epoch.rolloverPendingIn && (
        <div className="mb-4 flex items-start gap-2 rounded-2xl border border-brand-ring bg-brand-soft px-4 py-3 text-sm text-brand">
          <Trophy className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Rollover carried in:{' '}
            <span className="font-mono">
              <BaseAmount value={epoch.rolloverInWETH} />
            </span>{' '}
            +{' '}
            <span className="font-mono">
              <MoneyAmount value={epoch.rolloverInUSDC} token="USDC" /> USDC
            </span>{' '}
            injected into this epoch&apos;s pot.
          </span>
        </div>
      )}

      {boundary && (
        <div className="mb-4 flex items-center justify-between rounded-2xl border border-line bg-surface-muted px-4 py-3">
          <span className="flex items-center gap-2 text-sm text-ink-muted">
            <Clock className="h-4 w-4" />
            {boundary.label}
          </span>
          <span className="text-lg">
            <Countdown target={boundary.target} />
          </span>
        </div>
      )}

      {/* Hero: the pot - what's actually at stake this epoch, in dollars (pot tokens × oracle price). */}
      <div className="rounded-2xl border border-line bg-surface-muted px-4 py-3.5">
        <div className="kicker">Pot at stake</div>
        <div
          data-testid="pot-usd"
          className="mt-1 font-mono text-[28px] font-semibold leading-none tnum text-brand"
        >
          {formatUsd6(potUsdValue6)}
        </div>
        <div className="mt-1.5 text-xs text-ink-muted">
          <BaseAmount value={epoch.potWETH} /> +{' '}
          <MoneyAmount value={epoch.potUSDC} token="USDC" /> USDC
          {oraclePrice18 === 0n && ' · base leg pending oracle'}
        </div>
      </div>

      {/* Explore-style stat row: label + big bold number, separated by hairline dividers. */}
      <div className="mt-3 grid grid-cols-2 divide-x divide-line rounded-2xl border border-line">
        <div className="px-4 py-3">
          <div className="kicker">Start price</div>
          <div className="mt-1 font-mono text-base font-medium tnum text-ink">
            {hasStart ? <MoneyAmount value={epoch.startPrice18} token="price" /> : '-'}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-faint">
            {hasStart ? priceLabel : 'not started'}
          </div>
        </div>
        <div className="px-4 py-3">
          <div className="kicker">Settle price</div>
          <div className="mt-1 font-mono text-base font-medium tnum text-ink">
            {hasSettle ? <MoneyAmount value={epoch.settlePrice18} token="price" /> : '-'}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-faint">
            {hasSettle ? priceLabel : 'not ended'}
          </div>
        </div>
      </div>

      {/* Implied move to win - a pure restatement of the band, not a probability/odds claim. */}
      <p
        data-testid="implied-move"
        className="mt-3 flex items-start gap-1.5 rounded-2xl border border-line bg-surface-muted px-4 py-3 text-sm text-ink-soft"
      >
        <ArrowUp className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
        <span>{impliedMoveText(epoch.bandBps, sym)}</span>
      </p>

      <dl className="mt-4 divide-y divide-line">
        <DataRow label="Oracle price">
          {oracle ? <MoneyAmount value={oracle.price18} token="price" /> : '-'}
        </DataRow>
        <DataRow label="Band">{formatBps(epoch.bandBps)}</DataRow>
        <DataRow label="Delta">
          {hasSettle ? (
            <span
              className={cn(
                'font-semibold',
                epoch.deltaBps > 0n && 'text-side-up',
                epoch.deltaBps < 0n && 'text-side-down',
              )}
            >
              {formatDeltaBps(epoch.deltaBps)}
            </span>
          ) : (
            '-'
          )}
        </DataRow>
        <DataRow label="Staked positions">{epoch.stakedCount}</DataRow>
        {isSettled && (
          <DataRow label="Winning side">
            {epoch.rolledOver
              ? 'Empty winner - pot rolled forward'
              : epoch.winningSide !== Side.NONE
                ? SIDE_LABELS[epoch.winningSide]
                : '-'}
          </DataRow>
        )}
      </dl>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-faint">
        <Activity className="h-3.5 w-3.5 shrink-0" />
        Epochs run automatically on a fixed schedule (start → settle → next) - you only stake during the
        entry window.
      </p>
      {!isSettled && (
        <p className="mt-2 text-xs text-ink-faint">
          Winner &amp; share are hidden until the epoch settles. Per-side staked depth totals are shown
          below.
        </p>
      )}
    </SectionCard>
  );
}
