'use client';

// components/arena/EpochCenterPanel.tsx - the Arena CENTER column (the hero). Phase pill, a large split
// countdown, the live pot at stake, and the oracle price with its change-since-epoch-start + a sparkline
// of recent oracle reads. All REAL: epoch/phase/countdown from EpochView, pot from potUsd6, price from
// the Pyth-backed oracle. The "+2.1%" is the change vs the epoch's start price (honest, labelled), and
// the sparkline draws from in-session oracle samples (a "collecting" placeholder until 2+ points exist).
import { useEffect, useRef, useState } from 'react';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { useChainTime } from '@/hooks/useChainTime';
import { usePriceSamples } from '@/hooks/usePriceSamples';
import { useFeesSettled } from '@/hooks/useFeesSettled';
import { useActiveMarket } from '@/components/MarketProvider';
import { ArenaPanel } from '@/components/arena/ArenaPanel';
import { MiniSparkline } from '@/components/arena/MiniSparkline';
import { Skeleton } from '@/components/ui/Skeleton';
import { Logo } from '@/components/ui/icons';
import { PhaseView } from '@/lib/types';
import { potUsd6, formatUsd6Precise } from '@/lib/quant';
import { priceChangePct, formatSignedPct, formatUsdPrice18 } from '@/lib/arena';
import { cn } from '@/lib/cn';

const PHASE_META: Record<PhaseView, { text: string; live: boolean }> = {
  [PhaseView.Idle]: { text: 'Starting soon', live: false },
  [PhaseView.EntryOpen]: { text: 'Entry open', live: true },
  [PhaseView.Running]: { text: 'In progress', live: true },
  [PhaseView.Settled]: { text: 'Settled', live: false },
};

/**
 * The next phase boundary the countdown targets, plus the honest "stall" label shown when that
 * boundary has PASSED but the phase hasn't advanced yet (the keeper crank is pending - e.g. an Arc
 * base-fee spike). A frozen 00:00:00 reads like a bug; "Settling round…" tells the truth.
 *
 * Idle deliberately has NO countdown (target: null): the entry clock starts ticking on-chain at
 * createEpoch, a few seconds BEFORE openEntry flips the phase - so a countdown under "Starting
 * soon" reads as "the epoch starts in 3:00" when it is really the entry window that is about to
 * be open. Idle lasts only a few seconds; in the v3 lifecycle an Idle epoch N exists ONLY because
 * epoch N-1 just settled (createEpoch requires it), so the honest render names that outcome:
 * "Epoch N-1 settled - opening entry…".
 */
function boundaryFor(epoch: {
  epochId: bigint;
  phase: PhaseView;
  entryCloseTime: bigint;
  startTime: bigint;
  endTime: bigint;
}): { target: bigint | null; stall: string } | null {
  switch (epoch.phase) {
    case PhaseView.EntryOpen:
      return { target: epoch.entryCloseTime, stall: 'Starting round…' };
    case PhaseView.Running:
      return { target: epoch.endTime, stall: 'Settlement in progress…' };
    case PhaseView.Idle:
      return {
        target: null,
        stall: epoch.epochId > 1n ? `Epoch #${(epoch.epochId - 1n).toString()} settled - opening entry…` : 'Opening entry…',
      };
    default:
      return null;
  }
}

function pad2(n: number): string {
  return Math.max(0, n).toString().padStart(2, '0');
}

/** The big HRS:MINS:SECS countdown (chain-time based), each pair stacked over a small label.
 *  When the boundary has passed (phase advance pending on the keeper) - or the phase has no
 *  countdown at all (target: null, e.g. Idle) - shows `stallLabel` instead of a dead 00:00:00. */
function BigCountdown({ target, stallLabel }: { target: bigint | null; stallLabel: string }) {
  const { now } = useChainTime();
  const remaining = target === null ? 0 : Math.max(0, Number(target) - Number(now));
  if (remaining <= 0) {
    return (
      <div
        data-testid="countdown"
        className="flex min-h-[84px] items-center justify-center gap-2.5"
        aria-live="polite"
      >
        <span className="h-2 w-2 animate-pulse-soft rounded-full bg-brand" aria-hidden="true" />
        <span className="font-mono text-xl font-semibold uppercase tracking-[0.16em] text-ink-soft sm:text-2xl">
          {stallLabel}
        </span>
      </div>
    );
  }
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  const cell = (val: string, label: string) => (
    <div className="flex flex-col items-center">
      <span className="font-mono text-5xl font-semibold tnum leading-none text-ink sm:text-6xl">{val}</span>
      <span className="mt-2 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">{label}</span>
    </div>
  );
  return (
    <div
      data-testid="countdown"
      className="flex items-start justify-center gap-3 sm:gap-4"
      aria-label="Time remaining"
    >
      {cell(pad2(h), 'Hrs')}
      <span className="font-mono text-4xl font-semibold leading-none text-ink-faint sm:text-5xl">:</span>
      {cell(pad2(m), 'Mins')}
      <span className="font-mono text-4xl font-semibold leading-none text-ink-faint sm:text-5xl">:</span>
      {cell(pad2(s), 'Secs')}
    </div>
  );
}

export function EpochCenterPanel() {
  const { data: epoch, isLoading } = useCurrentEpoch();
  const { data: oracle } = useOraclePrice();
  const market = useActiveMarket();
  const samples = usePriceSamples();
  const { data: feesSettled } = useFeesSettled();

  // SETTLED HANDOFF NOTICE. The settlement pipeline rolls Settled -> CREATE -> OPEN in seconds,
  // so polling often jumps straight from the old epoch to the new one's EntryOpen without ever
  // rendering Idle - and the "settled" outcome would flash past unseen. When the epochId advances,
  // remember the just-settled epoch for a few seconds and confirm it under the new countdown.
  const prevEpochIdRef = useRef<bigint | undefined>(undefined);
  const [settledNotice, setSettledNotice] = useState<{ epochId: bigint; until: number } | undefined>(undefined);
  const epochId = epoch?.epochId;
  useEffect(() => {
    if (epochId === undefined) return;
    const prev = prevEpochIdRef.current;
    if (prev !== undefined && epochId > prev) {
      setSettledNotice({ epochId: epochId - 1n, until: Date.now() + 8_000 });
    }
    prevEpochIdRef.current = epochId;
  }, [epochId]);
  // Quote currency for the fee pool + oracle-price labels. The arena settles/quotes in this market's
  // QUOTE token (USDC → USD/$, EURC → EUR/€). Absent quoteSymbol = USDC market (unchanged "USD"/"$").
  const quoteLabel = market.quoteSymbol ?? 'USD';
  const quoteCcy = market.quoteSymbol === 'EURC' ? '€' : '$';

  if (isLoading || !epoch) {
    return (
      <ArenaPanel joint="both" className="h-full px-7 py-8">
        <Skeleton className="mx-auto h-80 w-full max-w-sm" />
      </ArenaPanel>
    );
  }

  const phase = PHASE_META[epoch.phase];
  const boundary = boundaryFor(epoch);

  const oraclePrice18 = oracle?.price18 ?? 0n;
  // FEES SETTLED: cumulative TOTAL trading fees the arena has collected across every settled epoch
  // (PositionProcessed.feeBase/feeUSDC - winner-KEPT fees included, not just the small losers' forfeited
  // pot). The honest "real fee activity" figure: it grows in visible cents as swaps generate fees. The
  // live epoch's fees aren't collected until settlement, so this is a settled-to-date total.
  const feesSettledUsd6 = potUsd6({
    potWETH: feesSettled?.feeBase ?? 0n,
    potUSDC: feesSettled?.feeUSDC ?? 0n,
    baseDecimals: market.baseDecimals,
    price18: oraclePrice18,
  });

  const change = priceChangePct(epoch.startPrice18, oraclePrice18);

  return (
    <ArenaPanel joint="both" className="flex h-full flex-col items-center px-7 py-7 text-center">
      {/* Phase pill */}
      <div className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-muted px-3.5 py-1.5">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            phase.live ? 'animate-pulse-soft bg-brand' : 'bg-ink-faint',
          )}
          aria-hidden="true"
        />
        <span className="font-mono text-[12px] font-semibold uppercase tracking-wide text-ink">
          Epoch #{epoch.epochId.toString()}
        </span>
        <span className="text-ink-faint" aria-hidden="true">
          ·
        </span>
        <span
          className={cn(
            'font-mono text-[12px] font-semibold uppercase tracking-wide',
            phase.live ? 'text-brand' : 'text-ink-muted',
          )}
        >
          {phase.text}
        </span>
      </div>

      {/* Countdown */}
      <div className="mt-7">
        {boundary ? (
          <BigCountdown target={boundary.target} stallLabel={boundary.stall} />
        ) : (
          <div className="font-mono text-4xl font-semibold text-ink-muted">Epoch settled</div>
        )}
      </div>

      {/* Settled handoff - confirms the previous epoch's settlement for a few seconds after the
          new round opens (the on-chain Settled/Idle phases roll over too fast to render). */}
      {epoch.phase === PhaseView.EntryOpen && settledNotice !== undefined && Date.now() < settledNotice.until && (
        <div
          data-testid="settled-notice"
          className="mt-3 inline-flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-side-up" aria-hidden="true" />
          Epoch #{settledNotice.epochId.toString()} settled - new round open
        </div>
      )}

      {/* Grow spacer (equal-height stretch distributes extra room between the content groups). */}
      <div aria-hidden="true" className="min-h-6 w-full flex-1" />

      {/* Decorative divider with the brand mark */}
      <div className="flex w-full items-center gap-3 text-ink-faint/60">
        <span className="h-px flex-1 bg-line" />
        <Logo className="h-3.5 w-3.5 text-line-strong" />
        <span className="h-px flex-1 bg-line" />
      </div>

      {/* Fees settled - cumulative TOTAL trading fees collected across this market's epochs (winner-kept
          included), not just the live pot (which is 0 until settlement). */}
      <div className="mt-6">
        <div className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-ink-muted">Fees settled</div>
        <div data-testid="pot-usd" className="mt-1.5 font-mono text-5xl font-semibold tnum leading-none text-ink sm:text-6xl">
          {formatUsd6Precise(feesSettledUsd6, quoteCcy)}
        </div>
        <div className="mt-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
          Settled to date
        </div>
      </div>

      {/* Grow spacer */}
      <div aria-hidden="true" className="min-h-6 w-full flex-1" />

      {/* Crimson divider - DASHED red lines with the small glowing brand mark (reference ornament). */}
      <div className="flex w-full items-center gap-2.5" aria-hidden="true">
        <span className="h-0 flex-1 border-t border-dashed border-brand/45" />
        <Logo className="h-3 w-3 text-brand drop-shadow-[0_0_4px_rgb(229_72_77/0.65)]" />
        <span className="h-0 flex-1 border-t border-dashed border-brand/45" />
      </div>

      {/* Oracle price + change */}
      <div className="mt-5">
        <div className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-ink-muted">
          Oracle price ({quoteLabel})
        </div>
        <div className="mt-1.5 font-mono text-4xl font-semibold tnum leading-none text-ink">
          {oraclePrice18 > 0n ? formatUsdPrice18(oraclePrice18, quoteCcy) : '-'}
        </div>
        {change !== undefined && (
          <div
            className={cn(
              'mt-1.5 text-sm font-semibold tnum',
              change > 0 ? 'text-side-up' : change < 0 ? 'text-side-down' : 'text-ink-muted',
            )}
          >
            {formatSignedPct(change)}
            <span className="ml-1 font-normal text-ink-faint">since start</span>
          </div>
        )}
      </div>

      {/* Sparkline (real in-session samples) */}
      <div className="mt-4 h-16 w-full max-w-md">
        {samples.length >= 2 ? (
          <MiniSparkline values={samples} className="h-full w-full" />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-ink-faint">
            Collecting live prices…
          </div>
        )}
      </div>

      {/* Source (the pair itself is labelled above the price; reference shows "LIVE · Pyth Network") */}
      <div className="mt-3 inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-side-up" aria-hidden="true" />
        Live · Pyth Network
      </div>
    </ArenaPanel>
  );
}
