'use client';

import { useAccount } from 'wagmi';
import { useUserStakes } from '@/hooks/useUserStakes';
import { useEpoch } from '@/hooks/useEpoch';
import { usePreviewClaim } from '@/hooks/usePreviewClaim';
import { usePreviewRefund } from '@/hooks/usePreviewRefund';
import { useSweepProgress } from '@/hooks/useSweepProgress';
import { useClaim } from '@/hooks/useClaim';
import { useRefundConviction } from '@/hooks/useRefundConviction';
import { useUnstake } from '@/hooks/useUnstake';
import { useWithdrawCredited } from '@/hooks/useWithdrawCredited';
import { useIsEmbeddedWallet } from '@/hooks/useIsEmbeddedWallet';
import { CircleTxStatus } from '@/components/circle/CircleTxStatus';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV2Market, isV3Market } from '@/lib/markets';
import { quoteToken } from '@/lib/tokens';
import { SectionCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { TxButton } from '@/components/TxButton';
import { MoneyAmount, BaseAmount } from '@/components/MoneyAmount';
import { Trophy } from '@/components/ui/icons';
import { PhaseView, Side, type StakeView } from '@/lib/types';
import { SIDE_LABELS } from '@/lib/side';
import { formatUsdPrice18, formatSignedPct } from '@/lib/arena';
import type { StakeV3View, ClaimPreviewV3 } from '@/lib/epochV3';

function SideTag({ side }: { side: Side }) {
  const tone =
    side === Side.UP ? 'up' : side === Side.DOWN ? 'down' : side === Side.RANGE ? 'range' : 'neutral';
  return <Badge tone={tone}>{SIDE_LABELS[side]}</Badge>;
}

// ── v1 row: Claim (pot share) + Unstake (NFT). Conviction does not exist in v1. ──────────────────
function ClaimUnstakeRowV1({ stake }: { stake: StakeView }) {
  const { data: epoch } = useEpoch(stake.epochId);
  const { data: preview } = usePreviewClaim(stake.epochId, stake.tokenId);
  const { data: sweep } = useSweepProgress(stake.epochId);
  const { claim, isPending: claimPending } = useClaim();
  const { unstake, isPending: unstakePending } = useUnstake();

  const isSettled = epoch?.phase === PhaseView.Settled;
  const sweepDone = sweep ? sweep.done === sweep.total : false;

  // Claim: gate on previewClaim.claimable (settled + !rolledOver + sweepDone + winner + !claimed + contribution>0).
  // An out-of-range winner has contribution6==0 => claimable===false => button stays disabled, avoiding a revert.
  const canClaim = preview?.claimable === true;

  // Unstake: Settled + position.swept + !unstaked. The keeper auto-returns every position
  // right after settlement (unstakeBatch), so this manual button is a fallback for the
  // short crank window — or for a contract wallet whose auto-return was parked.
  const canUnstake = isSettled && stake.swept && !stake.unstaked;

  return (
    <div
      data-testid={`row-${stake.tokenId.toString()}`}
      className="rounded-2xl border border-line bg-surface px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="inline-flex items-center gap-2 font-mono text-ink">
          <span>
            Epoch #{stake.epochId.toString()} · #{stake.tokenId.toString()}
          </span>
          <SideTag side={stake.side} />
        </span>
        {preview?.isWinner && (preview.payWETH > 0n || preview.payUSDC > 0n) && (
          <span className="font-mono font-medium text-side-up">
            <BaseAmount value={preview.payWETH} /> +{' '}
            <MoneyAmount value={preview.payUSDC} token="USDC" /> USDC
          </span>
        )}
        {preview?.isWinner && preview.payWETH === 0n && preview.payUSDC === 0n && (
          <span className="text-xs text-amber-600">
            {epoch && (epoch.potWETH > 0n || epoch.potUSDC > 0n)
              ? 'Winning side, but this position was out of range this epoch — it earned no share of the pot.'
              : 'Winning side — but the pot was empty this epoch (no trading fees were forfeited), so there was nothing to split.'}
          </span>
        )}
      </div>

      {!isSettled && (
        <p className="mt-2 text-xs font-medium text-amber-600">
          Locked until the operator settles epoch #{stake.epochId.toString()}.
        </p>
      )}
      {isSettled && !sweepDone && (
        <p className="mt-2 text-xs font-medium text-amber-600">
          Waiting for sweep to finish ({sweep?.done ?? 0}/{sweep?.total ?? 0}) before claims open.
        </p>
      )}
      {isSettled && preview && !preview.isWinner && (
        <p className="mt-2 text-xs text-ink-muted">
          Wrong side — no reward. Your LP comes back to your wallet automatically.
        </p>
      )}
      {canUnstake && (
        <p className="mt-2 text-xs text-ink-muted">
          Your LP is being returned automatically — or pull it now without waiting.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <TxButton
          label={preview?.alreadyClaimed ? 'Claimed' : 'Claim'}
          disabled={!canClaim || claimPending}
          isPending={claimPending}
          onClick={() => claim({ epochId: stake.epochId, tokenId: stake.tokenId })}
        />
        {stake.unstaked ? (
          <span
            data-testid="auto-returned"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-side-up"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <path d="M2.5 8.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            LP returned to your wallet
          </span>
        ) : (
          <TxButton
            label="Unstake"
            disabled={!canUnstake || unstakePending}
            isPending={unstakePending}
            onClick={() => unstake({ tokenId: stake.tokenId })}
          />
        )}
      </div>
    </div>
  );
}

// ── v2 row: conviction-parimutuel. A WINNER collects TWO things (decoupled on-chain):
//      1. CLAIM — the sqrt-weighted pot share (previewClaim, gated on claimable).
//      2. REFUND CONVICTION — the staked conviction principal 1:1 (previewRefund, gated on refundable).
//    "Collect" fires whichever of the two is still outstanding (it may call both).
//    A LOSER's conviction is BURNED (forfeited) — there is NOTHING to claim or refund; we say so
//    explicitly and never render a refund affordance. Either way the LP NFT is recovered via Unstake.
function ClaimUnstakeRowV2({ stake }: { stake: StakeView }) {
  const { data: epoch } = useEpoch(stake.epochId);
  const { data: preview } = usePreviewClaim(stake.epochId, stake.tokenId);
  const { data: refund } = usePreviewRefund(stake.epochId, stake.tokenId);
  const { data: sweep } = useSweepProgress(stake.epochId);
  const { claim, isPending: claimPending } = useClaim();
  const { refundConviction, isPending: refundPending } = useRefundConviction();
  const { unstake, isPending: unstakePending } = useUnstake();

  const isSettled = epoch?.phase === PhaseView.Settled;
  const sweepDone = sweep ? sweep.done === sweep.total : false;

  const isWinner = preview?.isWinner === true;
  // The winner is determined once the epoch resolves; a LOSER (settled, !winner) burns their conviction.
  const isLoser = isSettled && preview !== undefined && !isWinner;

  const canClaim = preview?.claimable === true;
  const canRefund = refund?.refundable === true;
  // "Collect" handles a winner's outstanding obligations: claim (if claimable) and/or refund (if refundable).
  const canCollect = canClaim || canRefund;
  const collectPending = claimPending || refundPending;

  const canUnstake = isSettled && stake.swept && !stake.unstaked;

  async function onCollect() {
    // Fire both legs the winner still has outstanding. Each is independently gated on-chain, so doing
    // both is safe; we await sequentially so the two writes don't race the same nonce.
    if (canClaim) await claim({ epochId: stake.epochId, tokenId: stake.tokenId });
    if (canRefund) await refundConviction({ epochId: stake.epochId, tokenId: stake.tokenId });
  }

  return (
    <div
      data-testid={`row-${stake.tokenId.toString()}`}
      className="rounded-2xl border border-line bg-surface px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="inline-flex items-center gap-2 font-mono text-ink">
          <span>
            Epoch #{stake.epochId.toString()} · #{stake.tokenId.toString()}
          </span>
          <SideTag side={stake.side} />
        </span>
        {isWinner && (preview!.payWETH > 0n || preview!.payUSDC > 0n) && (
          <span className="font-mono font-medium text-side-up">
            <BaseAmount value={preview!.payWETH} /> +{' '}
            <MoneyAmount value={preview!.payUSDC} token="USDC" /> USDC
          </span>
        )}
      </div>

      {/* Per-leg detail for a winner: the pot share + the conviction refund principal. */}
      {isWinner && (
        <div className="mt-2 space-y-1 text-xs text-ink-muted">
          {preview!.payWETH === 0n && preview!.payUSDC === 0n && (
            <p className="text-amber-600">
              Winning side, but this position was out of range — earned no pot share.
            </p>
          )}
          {refund && refund.amount > 0n && (
            <p>
              Conviction to refund:{' '}
              <span className="font-mono text-ink">
                <MoneyAmount value={refund.amount} token="USDC" /> USDC
              </span>
              {!canRefund && ' (already refunded)'}
            </p>
          )}
        </div>
      )}

      {!isSettled && (
        <p className="mt-2 text-xs font-medium text-amber-600">
          Locked until the operator settles epoch #{stake.epochId.toString()}.
        </p>
      )}
      {isSettled && !sweepDone && (
        <p className="mt-2 text-xs font-medium text-amber-600">
          Waiting for sweep to finish ({sweep?.done ?? 0}/{sweep?.total ?? 0}) before collect opens.
        </p>
      )}
      {/* LOSER: conviction is forfeited/burned. Do NOT imply any refund. */}
      {isLoser && (
        <p className="mt-2 text-xs text-ink-muted">
          Wrong side — your conviction was forfeited (burned) and nothing is collectable. You can still
          unstake to recover your position NFT.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        {/* Winners see Collect; losers see no collect affordance at all (nothing to collect). */}
        {!isLoser && (
          <TxButton
            label={preview?.alreadyClaimed && !canRefund ? 'Collected' : 'Collect'}
            disabled={!canCollect || collectPending}
            isPending={collectPending}
            onClick={() => void onCollect()}
          />
        )}
        <TxButton
          label={stake.unstaked ? 'Unstaked' : 'Unstake'}
          disabled={!canUnstake || unstakePending}
          isPending={unstakePending}
          onClick={() => unstake({ tokenId: stake.tokenId })}
        />
      </div>
    </div>
  );
}

// ── v3 row (ENTRY-ANCHORED): per-position result language. There is NO global winner — the
//    position resolved against ITS OWN entry price, so every line speaks about "your entry"
//    and "your call". Winners claim own fees + the pot share; losers lose only the round's
//    fees; everyone's LP auto-returns after settlement.
function ClaimUnstakeRowV3({ stake }: { stake: StakeView }) {
  const v3 = (stake as StakeV3View).v3;
  // This arena's quote token (USDC or EURC) — both 6dp, so only the symbol LABEL differs.
  const quoteSymbol = quoteToken(useActiveMarket().quoteSymbol).symbol;
  const quoteGlyph = quoteSymbol === 'EURC' ? '€' : '$'; // EUR-settled market shows € prices, not $
  const { data: epoch } = useEpoch(stake.epochId);
  const { data: previewRaw } = usePreviewClaim(stake.epochId, stake.tokenId);
  const preview = previewRaw as ClaimPreviewV3 | undefined;
  const { claim, isPending: claimPending } = useClaim();
  const { unstake, isPending: unstakePending } = useUnstake();
  const isEmbedded = useIsEmbeddedWallet();

  const isSettled = epoch?.phase === PhaseView.Settled;
  const finalPrice18 = epoch?.settlePrice18 ?? 0n; // adaptEpochV3 maps finalPrice18 here
  const entry = v3?.entryPrice18 ?? 0n;
  const changePct = preview ? Number(preview.v3?.changeBps ?? 0n) / 100 : undefined;

  const canClaim = preview?.claimable === true;
  const canUnstake = isSettled && !stake.unstaked;
  const alreadyClaimed = preview?.alreadyClaimed === true;
  // A WINNER whose position produced no trading fees this round has nothing to claim: in the
  // entry-anchored model the reward IS fees (you keep your own + split the losers' forfeited fees),
  // so a round with no swaps — hence no fees and no forfeited pot — has no reward pool to distribute.
  const wonWithReward = isSettled && v3?.processed === true && v3.won && canClaim;
  const wonNoReward =
    isSettled && v3?.processed === true && v3.won && !canClaim && !alreadyClaimed;

  return (
    <div
      data-testid={`row-${stake.tokenId.toString()}`}
      className="rounded-2xl border border-line bg-surface px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="inline-flex items-center gap-2 font-mono text-ink">
          <span>
            Epoch #{stake.epochId.toString()} · #{stake.tokenId.toString()}
          </span>
          <SideTag side={stake.side} />
        </span>
        {preview?.isWinner && (preview.payWETH > 0n || preview.payUSDC > 0n) && (
          <span className="font-mono font-medium text-side-up">
            <BaseAmount value={preview.payWETH} /> + <MoneyAmount value={preview.payUSDC} token="USDC" /> {quoteSymbol}
          </span>
        )}
      </div>

      {/* THE anchor line — always show what this position is measured against. */}
      <p className="mt-2 text-xs text-ink-muted">
        Your entry anchor:{' '}
        <span className="font-mono text-ink">{entry > 0n ? formatUsdPrice18(entry, quoteGlyph) : '—'}</span>
        {isSettled && finalPrice18 > 0n && (
          <>
            {' '}
            → settled <span className="font-mono text-ink">{formatUsdPrice18(finalPrice18, quoteGlyph)}</span>
            {changePct !== undefined && (
              <span className={changePct >= 0 ? 'text-side-up' : 'text-side-down'}>
                {' '}
                ({formatSignedPct(changePct)})
              </span>
            )}
          </>
        )}
      </p>

      {!isSettled && (
        <p className="mt-1.5 text-xs font-medium text-amber-600">
          Locked until settlement — your result is measured against YOUR entry, not a global start.
        </p>
      )}
      {wonWithReward && (
        <p className="mt-1.5 text-xs text-side-up">
          Your {SIDE_LABELS[stake.side]} view qualified against your entry reference price. Claim your fees
          plus your share of the pool forfeited by non-qualifying positions.
        </p>
      )}
      {alreadyClaimed && (
        <p className="mt-1.5 text-xs text-side-up">
          Your {SIDE_LABELS[stake.side]} view qualified against your entry reference price, and you&apos;ve
          claimed your reward.
        </p>
      )}
      {wonNoReward && (
        <p className="mt-1.5 text-xs text-ink-muted">
          Your {SIDE_LABELS[stake.side]} view qualified, but no fees were generated during this epoch, so
          there is nothing to claim. Fee distributions only occur when participating positions generate
          fees. Your LP position has returned to your wallet.
        </p>
      )}
      {isSettled && v3?.processed && !v3.won && (
        <p className="mt-1.5 text-xs text-ink-muted">
          Your {SIDE_LABELS[stake.side]} view did not qualify against your entry reference price. Any fees
          generated by this position during the epoch were added to the fee pool. Your LP principal remains
          intact and returns automatically.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        {/* Claim affordance, honest about the entry-anchored reward model:
            - claimable winner -> enabled Claim
            - already claimed   -> "Claimed"
            - winner, no fees   -> a clear, disabled "Nothing to claim" (NOT a dead "Claim")
            - loser / pre-settle -> no claim button at all (nothing was ever claimable) */}
        {canClaim || alreadyClaimed ? (
          <TxButton
            label={alreadyClaimed ? 'Claimed' : 'Claim'}
            disabled={!canClaim || claimPending}
            isPending={claimPending}
            onClick={() => claim({ epochId: stake.epochId, tokenId: stake.tokenId })}
          />
        ) : wonNoReward ? (
          <span className="inline-flex h-9 items-center rounded-xl border border-line px-3 text-xs font-medium text-ink-faint">
            Nothing to claim
          </span>
        ) : null}
        {stake.unstaked ? (
          <span
            data-testid="auto-returned"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-side-up"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <path d="M2.5 8.5l3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            LP returned to your wallet
          </span>
        ) : (
          <TxButton
            label="Unstake"
            disabled={!canUnstake || unstakePending}
            isPending={unstakePending}
            onClick={() => unstake({ tokenId: stake.tokenId })}
          />
        )}
      </div>

      {/* Circle write-path: when the embedded connector is active, this claim/unstake's wagmi write
          routes through Circle's contractExecution (eth_sendTransaction → executeContract). */}
      {(claimPending || unstakePending) && (
        <CircleTxStatus phase="pending" isEmbedded={isEmbedded} className="mt-2.5" />
      )}
    </div>
  );
}

function ClaimUnstakeRow({ stake, v2, v3 }: { stake: StakeView; v2: boolean; v3: boolean }) {
  if (v3) return <ClaimUnstakeRowV3 stake={stake} />;
  return v2 ? <ClaimUnstakeRowV2 stake={stake} /> : <ClaimUnstakeRowV1 stake={stake} />;
}

// ── v2-only: deferred (blocklist-resilient) payout recovery. When a winner's claim/refund payout
//    could not be sent directly (a blocklisted owner address), the arena credited owedUSDC/owedWETH.
//    This banner surfaces that balance + a withdrawCredited(to) action to a clean wallet. Hidden when
//    there is nothing credited (the common case).
function DeferredPayoutBanner() {
  const { owedUSDC, owedWETH, hasCredit, withdraw, isPending } = useWithdrawCredited();
  if (!hasCredit) return null;
  return (
    <div
      data-testid="deferred-payout-banner"
      className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3.5 dark:border-amber-700/50 dark:bg-amber-900/20"
    >
      <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
        Deferred payout pending
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        A previous payout could not be delivered to your address and was credited for later withdrawal.
        Pull it to a clean wallet:
      </p>
      <p className="mt-1 font-mono text-xs text-ink">
        {owedUSDC > 0n && (
          <>
            <MoneyAmount value={owedUSDC} token="USDC" /> USDC
          </>
        )}
        {owedUSDC > 0n && owedWETH > 0n && ' + '}
        {owedWETH > 0n && <BaseAmount value={owedWETH} />}
      </p>
      <div className="mt-3">
        <TxButton
          label="Withdraw credited"
          disabled={isPending}
          isPending={isPending}
          onClick={() => void withdraw()}
        />
      </div>
    </div>
  );
}

export function ClaimUnstakePanel() {
  const { address, isConnected } = useAccount();
  const { data: stakes } = useUserStakes(address);
  const market = useActiveMarket();
  const v2 = isV2Market(market);
  const v3 = isV3Market(market);

  if (!isConnected) {
    return (
      <SectionCard title="Your positions" icon={<Trophy className="h-5 w-5" />}>
        <p className="text-sm text-ink-muted">Connect a wallet to view your LP positions, active epochs, and claimable fees.</p>
      </SectionCard>
    );
  }

  // Exclude already-unstaked exits; keep losing positions (they still need to unstake).
  const rows = (stakes ?? []).filter((s) => !s.unstaked || (s.side !== Side.NONE && !s.claimed));

  return (
    <SectionCard title="Your positions" icon={<Trophy className="h-5 w-5" />}>
      {/* v2 deferred-payout recovery (renders only when something is credited). */}
      {v2 && <DeferredPayoutBanner />}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No positions to claim or unstake.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((s) => (
            <ClaimUnstakeRow key={s.tokenId.toString()} stake={s} v2={v2} v3={v3} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
