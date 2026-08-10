'use client';

// components/arena/StakeReviewModal.tsx — mockup #5. The final "Stake into Stance" review: a summary of
// the entry (position, range, chosen side, round, entry countdown, lock period, settlement source), the
// lock warning + payout note, then "Confirm stake". Confirm calls the existing useStakeWithSide hook
// (NPM.safeTransferFrom → FeeArena with the encoded side) — unchanged on-chain logic. The mockup's
// "2h external-oracle TWAP" becomes the REAL settlement source: Pyth spot at the band.
import { useStakeWithSide } from '@/hooks/useStakeWithSide';
import { useIsEmbeddedWallet } from '@/hooks/useIsEmbeddedWallet';
import { CircleTxStatus } from '@/components/circle/CircleTxStatus';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV3Market } from '@/lib/markets';
import { entryThresholds } from '@/lib/epochV3';
import { formatUsdPrice18 } from '@/lib/arena';
import { Countdown } from '@/components/Countdown';
import { ArenaModal, arenaButtonClass } from '@/components/arena/ArenaPanel';
import { usePositionRange } from '@/components/arena/usePositionRange';
import { SIDE_TEXT } from '@/components/arena/sides';
import { Stars } from '@/components/ui/Stars';
import {
  Shield,
  Lock,
  Clock,
  Calendar,
  Activity,
  RangeIcon,
  ArrowUp,
  ArrowDown,
  Gift,
  Alert,
} from '@/components/ui/icons';
import { PhaseView, Side } from '@/lib/types';
import { SIDE_LABELS, isValidStakeSide } from '@/lib/side';
import { formatBps } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { ArenaFlow } from '@/components/arena/useArenaFlow';
import type { ReactNode } from 'react';

const SIDE_ICON: Record<number, ReactNode> = {
  [Side.UP]: <ArrowUp className="h-4 w-4" />,
  [Side.DOWN]: <ArrowDown className="h-4 w-4" />,
  [Side.RANGE]: <RangeIcon className="h-4 w-4" />,
};

function ReviewRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line py-3 first:border-t-0">
      <span className="inline-flex items-center gap-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.05em] text-ink-muted">
        {/* Outlined icon tile (the reference's review rows carry square bordered chips). */}
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-muted/40 text-ink-muted">
          {icon}
        </span>
        {label}
      </span>
      <span className="text-right font-mono text-sm font-medium tnum text-ink">{value}</span>
    </div>
  );
}

export function StakeReviewModal({ flow }: { flow: ArenaFlow }) {
  const { data: epoch } = useCurrentEpoch();
  const market = useActiveMarket();
  const v3 = isV3Market(market);
  const quoteGlyph = market.quoteSymbol === 'EURC' ? '€' : '$'; // EUR-settled market shows € prices
  const { data: livePrice } = useOraclePrice();
  const range = usePositionRange(flow.selectedPosition);
  const { stake, isPending, error } = useStakeWithSide();
  const isEmbedded = useIsEmbeddedWallet();

  const open = flow.modal === 'stake-review';
  const side = flow.selectedSide;
  const sideLabel = SIDE_LABELS[side] ?? '—';
  const entryOpen = epoch?.phase === PhaseView.EntryOpen;
  const canConfirm =
    entryOpen && flow.selectedTokenId !== undefined && isValidStakeSide(side) && !isPending;

  // v3 ENTRY ANCHOR preview: the indicative reference (the live oracle price) + the personal
  // thresholds it implies. The REAL anchor is read on-chain at confirmation — within 0.5% of
  // this preview or the stake reverts (the slippage guard), so the box is honest.
  const liveRef = livePrice?.price18 ?? 0n;
  const thresholds = v3 && epoch && liveRef > 0n ? entryThresholds(liveRef, epoch.bandBps) : undefined;

  const onConfirm = async () => {
    if (flow.selectedTokenId === undefined || !isValidStakeSide(side)) return;
    try {
      await stake({ tokenId: flow.selectedTokenId, side });
      flow.closeModal();
    } catch {
      // error surfaced below
    }
  };

  return (
    <ArenaModal open={open} onClose={flow.closeModal} className="max-w-xl">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-side-up/40 bg-side-up/10 text-side-up">
          <Shield className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-mono text-xl font-semibold tracking-tight text-ink">Stake into Stance</h2>
          <p className="text-sm text-ink-soft">Review your epoch entry before confirming.</p>
        </div>
      </div>

      <div className="mt-5">
        <ReviewRow
          icon={<Activity className="h-4 w-4" />}
          label="Position"
          value={
            <span className="font-mono">
              {market.baseSymbol} / USDC · #{flow.selectedPosition?.tokenId.toString() ?? '—'}
            </span>
          }
        />
        <ReviewRow icon={<RangeIcon className="h-4 w-4" />} label="Range" value={range?.label ?? '…'} />
        <ReviewRow
          icon={SIDE_ICON[side] ?? <Activity className="h-4 w-4" />}
          label="Market view"
          value={<span className={cn('font-semibold', SIDE_TEXT[side])}>{sideLabel}</span>}
        />
        <ReviewRow
          icon={<Calendar className="h-4 w-4" />}
          label="Epoch"
          value={epoch ? `#${epoch.epochId.toString()}` : '—'}
        />
        <ReviewRow
          icon={<Clock className="h-4 w-4" />}
          label="Entry closes in"
          value={
            epoch && entryOpen ? <Countdown target={epoch.entryCloseTime} /> : <span className="text-ink-muted">closed</span>
          }
        />
        <ReviewRow icon={<Lock className="h-4 w-4" />} label="Lock period" value="Until settlement" />
        <ReviewRow
          icon={<Shield className="h-4 w-4" />}
          label="Settlement source"
          value={
            epoch
              ? v3
                ? `Pyth settlement average · ±${formatBps(epoch.bandBps)} vs your entry price`
                : `Pyth spot · ±${formatBps(epoch.bandBps)}`
              : 'Pyth spot'
          }
        />
      </div>

      {/* v3 ENTRY ANCHOR box — the PDF's "net kutu": the user's own reference price + the exact
          thresholds their side needs. The price LOCKS at confirmation (slippage-guarded). */}
      {v3 && (
        <div
          data-testid="entry-anchor-box"
          className="mt-4 rounded-xl border border-line bg-surface-muted px-3.5 py-3"
        >
          <div className="font-mono text-[11px] font-medium uppercase tracking-[0.05em] text-ink-muted">
            Your {market.baseSymbol} reference price · locks at confirmation
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold tnum text-ink">
            {liveRef > 0n ? formatUsdPrice18(liveRef, quoteGlyph) : '—'}
            <span className="ml-2 align-middle text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              live · max 0.5% drift
            </span>
          </div>
          {thresholds && (
            <div className="mt-2 space-y-1 font-mono text-[13px] leading-snug">
              <div className="text-side-up">{'UP: final >= upperThreshold'}</div>
              <div className="text-side-down">{'DOWN: final <= lowerThreshold'}</div>
              <div className="text-ink-soft">{'RANGE: final > lowerThreshold && final < upperThreshold'}</div>
            </div>
          )}
          <p className="mt-2 text-[12px] leading-snug text-ink-muted">
            Your result is measured against YOUR entry price — entering later means a later anchor,
            never an advantage.
          </p>
        </div>
      )}

      {/* Lock warning */}
      <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-300/50 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
        <Alert className="mt-0.5 h-4 w-4 shrink-0" />
        Once entered, this position remains locked until settlement.
      </p>

      {/* Payout note (the reference's gift row: white headline + muted caption on a quiet card). */}
      <div className="mt-2.5 flex items-start gap-2.5 rounded-xl border border-line bg-surface-muted px-3.5 py-2.5">
        <Gift className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
        <div className="text-[13px] leading-snug">
          <div className="font-medium text-ink">
            Eligible to share the fee pool if this position qualifies.
          </div>
          <div className="text-ink-muted">
            Fees are distributed after settlement to qualifying positions by contribution.
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2.5 text-sm text-side-down">
          {error.message}
        </p>
      )}

      {/* Circle write-path affordance: when the embedded connector is active, this stake's wagmi write
          routes through Circle's contractExecution (eth_sendTransaction → executeContract). */}
      <CircleTxStatus phase={isPending ? 'pending' : 'idle'} isEmbedded={isEmbedded} className="mt-3" />

      {/* Actions */}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => flow.openModal('choose-side')}
          disabled={isPending}
          className={arenaButtonClass('secondary')}
        >
          Back
          <Stars />
        </button>
        <button
          type="button"
          data-testid="confirm-stake"
          disabled={!canConfirm}
          onClick={onConfirm}
          className={arenaButtonClass('primary')}
        >
          {isPending ? 'Staking…' : 'Confirm stake'}
          <Stars />
        </button>
      </div>
    </ArenaModal>
  );
}
