'use client';

// components/SettlementBanner.tsx - the WIN MOMENT. When the connected wallet holds a CLAIMABLE win in
// the just-settled current epoch, this renders a prominent dashboard banner ("DOWN won - you won ~$X -
// Claim") with a primary Claim CTA and a Share button, right where the user already is (claim is
// otherwise buried on /claim, unreachable on mobile). A subtle, one-shot celebration plays via the
// motion-safe `win-pop` animation (held still under prefers-reduced-motion).
//
// Numbers come from previewClaim (the contract's floor projection), NOT client payout math - only the
// USD valuation (payout tokens × the live oracle price) is computed here, and it's clearly framed "~$X".
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useUserStakes } from '@/hooks/useUserStakes';
import { usePreviewClaim } from '@/hooks/usePreviewClaim';
import { useClaim } from '@/hooks/useClaim';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { useActiveMarket } from '@/components/MarketProvider';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { ShareWinButton } from '@/components/ShareWinButton';
import { Trophy } from '@/components/ui/icons';
import { PhaseView, Side, type ClaimPreview, type StakeView } from '@/lib/types';
import { SIDE_LABELS } from '@/lib/side';
import { baseUsd6, formatUsd6 } from '@/lib/quant';

/** Per-stake claimable result reported up to the banner aggregator. */
interface WinEntry {
  tokenId: bigint;
  usd6: bigint; // payout valued in 6dp USD (base leg × oracle price + USDC leg)
  preview: ClaimPreview;
}

/**
 * Invisible probe: reads previewClaim for one stake and reports it up via onResult. Rendering one of
 * these per stake keeps hooks unconditional (no hooks-in-a-loop) - mirrors LiveStatus's PositionRealized.
 */
function ClaimableProbe({
  epochId,
  stake,
  baseDecimals,
  price18,
  onResult,
}: {
  epochId: bigint;
  stake: StakeView;
  baseDecimals: number;
  price18: bigint;
  onResult: (tokenId: bigint, entry: WinEntry | null) => void;
}) {
  const { data: preview } = usePreviewClaim(epochId, stake.tokenId);

  useEffect(() => {
    if (!preview) {
      onResult(stake.tokenId, null);
      return;
    }
    if (!preview.claimable) {
      onResult(stake.tokenId, null);
      return;
    }
    const usd6 = baseUsd6(preview.payWETH, baseDecimals, price18) + preview.payUSDC;
    onResult(stake.tokenId, { tokenId: stake.tokenId, usd6, preview });
    // Re-report when the preview or pricing inputs change.
  }, [preview, stake.tokenId, baseDecimals, price18, onResult]);

  return null;
}

export function SettlementBanner() {
  const { address, isConnected } = useAccount();
  const { data: epoch } = useCurrentEpoch();
  const { data: stakes } = useUserStakes(address);
  const { data: oracle } = useOraclePrice();
  const { claim, isPending: claimPending } = useClaim();
  const market = useActiveMarket();

  // Per-token claimable results, collected from the probes.
  const [entries, setEntries] = useState<Record<string, WinEntry | null>>({});

  const onResult = useCallback((tokenId: bigint, entry: WinEntry | null) => {
    setEntries((prev) => {
      const key = tokenId.toString();
      const existing = prev[key];
      // Skip a state update when nothing changed (prevents render loops).
      if (existing === undefined && entry === null) return { ...prev, [key]: null };
      if (
        existing &&
        entry &&
        existing.usd6 === entry.usd6 &&
        existing.preview.claimable === entry.preview.claimable
      ) {
        return prev;
      }
      if (existing === null && entry === null) return prev;
      return { ...prev, [key]: entry };
    });
  }, []);

  const isSettled = epoch?.phase === PhaseView.Settled;
  const epochId = epoch?.epochId;

  // Stakes in THIS (current, just-settled) epoch - the win moment is for the live settlement only.
  const myEpochStakes = useMemo(
    () =>
      epochId !== undefined
        ? (stakes ?? []).filter((s) => s.epochId === epochId)
        : [],
    [stakes, epochId],
  );

  // Aggregate the claimable wins reported by the probes (only for stakes still in this epoch).
  const wins = useMemo(() => {
    const live = new Set(myEpochStakes.map((s) => s.tokenId.toString()));
    return Object.entries(entries)
      .filter(([k, v]) => v !== null && live.has(k))
      .map(([, v]) => v as WinEntry);
  }, [entries, myEpochStakes]);

  const totalUsd6 = wins.reduce((sum, w) => sum + w.usd6, 0n);
  const hasClaimableWin = wins.length > 0;

  const onClaimAll = useCallback(() => {
    if (epochId === undefined) return;
    // Fire a claim per winning position. useClaim disables optimistically + toasts each.
    for (const w of wins) {
      void claim({ epochId, tokenId: w.tokenId });
    }
  }, [wins, epochId, claim]);

  // Nothing to show unless connected, settled, and the wallet actually has a claimable win here.
  if (!isConnected || !isSettled || epochId === undefined) {
    return (
      <>
        {/* Probes still mount (when settled) so results are ready the instant the banner qualifies. */}
        {isSettled &&
          epochId !== undefined &&
          myEpochStakes.map((s) => (
            <ClaimableProbe
              key={s.tokenId.toString()}
              epochId={epochId}
              stake={s}
              baseDecimals={market.baseDecimals}
              price18={oracle?.price18 ?? 0n}
              onResult={onResult}
            />
          ))}
      </>
    );
  }

  const winningLabel =
    epoch.winningSide !== Side.NONE ? SIDE_LABELS[epoch.winningSide] : SIDE_LABELS[Side.RANGE];

  return (
    <>
      {/* Probes (one per stake) feed the aggregator. They render nothing. */}
      {myEpochStakes.map((s) => (
        <ClaimableProbe
          key={s.tokenId.toString()}
          epochId={epochId}
          stake={s}
          baseDecimals={market.baseDecimals}
          price18={oracle?.price18 ?? 0n}
          onResult={onResult}
        />
      ))}

      {hasClaimableWin && (
        <div
          data-testid="settlement-banner"
          role="status"
          className="mb-6 overflow-hidden rounded-2xl border border-side-up-ring bg-side-up-soft shadow-card motion-safe:animate-win-pop"
        >
          <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-side-up text-white">
                <Trophy className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <p className="kicker text-side-up">Epoch #{epochId.toString()} settled</p>
                <p className="font-display text-lg font-semibold leading-tight text-ink">
                  {winningLabel} won - you won{' '}
                  <span data-testid="banner-amount" className="font-mono tnum text-side-up">
                    ~{formatUsd6(totalUsd6)}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {wins.length === 1
                    ? '1 winning position'
                    : `${wins.length} winning positions`}{' '}
                  · valued at the live oracle price
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ShareWinButton
                epochId={epochId}
                winningLabel={winningLabel}
                usd6={totalUsd6}
                variant="secondary"
                size="md"
              />
              <button
                type="button"
                data-testid="banner-claim"
                onClick={onClaimAll}
                disabled={claimPending}
                className={buttonClass('primary', 'md')}
              >
                {claimPending ? 'Claiming…' : `Claim ${formatUsd6(totalUsd6)}`}
                <Stars />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
