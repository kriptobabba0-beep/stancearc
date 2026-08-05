'use client';

// components/YourLiquidity.tsx - "Your positions" (the off-ramp), styled as Uniswap's Pool page.
//
// Lists the connected wallet's withdrawable LP positions for the ACTIVE market's pool (via
// useOwnedPositions, which excludes already-staked positions). Each position renders as a Uniswap-style
// position card: the overlapping pair glyph + the pair label (e.g. "cirBTC / USDC") + a fee-tier badge
// (0.3%) + the position's REAL price band ("Full range" or "min - max USDC" from its ticks) + an
// In range / Out of range status chip (the pool's current tick vs the band - out of range = earning
// no fees), the estimated tokens you'd reclaim, and a per-position "Withdraw" action that pulls 100%
// of that position's liquidity back to the wallet via useRemoveLiquidity. Base-token-agnostic (cirBTC 8dp);
// the band's human prices resolve the baseIsToken0=false inversion via lib/rangeMath tickToPrice.
//
// The empty / disconnected state mirrors Uniswap's Pool page exactly: a centered card with a wallet icon
// tile, a short message, a "New position" button (which reveals the Create-position form via onNewPosition)
// and - when disconnected - the wallet <Connect/> control. Pairs with the on-ramp (ProvideLiquidity).
import { useAccount, useReadContract } from 'wagmi';
import { useOwnedPositions } from '@/hooks/useOwnedPositions';
import { useRemoveLiquidity } from '@/hooks/useRemoveLiquidity';
import { useCollectFees, usePositionFees } from '@/hooks/useCollectFees';
import { useRemoveQuote } from '@/hooks/useRemoveQuote';
import { tickSpacingForFee } from '@/hooks/useMintPosition';
import { uniswapV3PoolAbi } from '@/abis';
import type { PoolInfo } from '@/lib/pools';
import { arcTestnet } from '@/lib/chain';
import { ENV } from '@/lib/env';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Connect } from '@/components/Connect';
import { TokenPairGlyph } from '@/components/TokenGlyph';
import { Wallet, ArrowDown, External, Plus, Spinner } from '@/components/ui/icons';
import { formatBase, formatBps, formatUSDC } from '@/lib/format';
import { tickRangeStatus } from '@/lib/rangeMath';
import { bandLabel, decodeSlot0, isFullRangeTicks } from '@/lib/rangeDisplay';
import { cn } from '@/lib/cn';
import type { OwnedPosition } from '@/lib/types';

/**
 * The estimated return for one position: simulate the exact remove path and show the cirBTC + USDC
 * that would land in the wallet (freed principal + any owed fees), formatted at full precision via the
 * lib/format helpers. While the estimate loads we show a hint; if it's unavailable (simulation
 * reverted) we gracefully fall back to the raw liquidity magnitude rather than crashing the row.
 */
function EstimatedReturn({ position, pool }: { position: OwnedPosition; pool: PoolInfo }) {
  const { base, usdc, baseDecimals, baseSymbol, isLoading, isError } = useRemoveQuote({
    tokenId: position.tokenId,
    liquidity: position.liquidity,
    base: { baseIsToken0: pool.baseIsToken0, decimals: pool.base.decimals, symbol: pool.base.symbol },
  });

  if (base !== undefined && usdc !== undefined) {
    return (
      <span
        className="font-mono text-ink-soft"
        title="Sent to your wallet on Withdraw - your principal PLUS all unclaimed fees, in one transaction."
      >
        Withdraw returns ≈ {formatBase(base, baseDecimals)} {baseSymbol} + {formatUSDC(usdc)} {pool.quote.symbol}
      </span>
    );
  }

  if (isLoading && !isError) {
    return <span className="font-mono text-ink-muted">estimating return…</span>;
  }

  // Estimate unavailable (reverted / no RPC) - fall back to the raw liquidity magnitude.
  return (
    <span className="font-mono text-ink-muted">liquidity: {position.liquidity.toString()}</span>
  );
}

/**
 * One Uniswap-style position card: the pair glyph + pair label + fee-tier badge + the position's REAL
 * range badge ("Full range" or its "min - max USDC" band) + an In range / Out of range status chip
 * across the top, the estimated reclaim amounts beneath, and a Withdraw action on the right. The
 * withdraw flow is unchanged - clicking calls useRemoveLiquidity(tokenId).remove which burns 100%.
 */
function PositionCard({ position, pool }: { position: OwnedPosition; pool: PoolInfo }) {
  // Base/quote come from the SELECTED pool (cirBTC/USDC, cirBTC/EURC, EURC/USDC) - never assumed to be
  // {non-USDC, USDC}, so cirBTC/EURC (no USDC leg) labels + amount mapping are correct.
  const baseSymbol = pool.base.symbol;
  const baseDecimals = pool.base.decimals;
  const quoteSymbol = pool.quote.symbol;
  const quoteDecimals = pool.quote.decimals;
  const baseIsToken0 = pool.baseIsToken0;
  const { remove, isPending, hash } = useRemoveLiquidity();
  const { collect, isPending: isCollecting, hash: collectHash } = useCollectFees();
  const { data: fees } = usePositionFees(position.tokenId);
  const id = position.tokenId.toString();
  const pair = `${baseSymbol} / ${quoteSymbol}`;

  // Map the collectable (amount0, amount1) to base/quote by the pool's token ordering, so a
  // liquidity-only provider can see and claim the trading fees their position has earned.
  const feeBase = fees ? (baseIsToken0 ? fees.amount0 : fees.amount1) : 0n;
  const feeUsdc = fees ? (baseIsToken0 ? fees.amount1 : fees.amount0) : 0n;
  const hasFees = feeBase > 0n || feeUsdc > 0n;

  // Live pool tick for the in/out-of-range chip (wagmi dedupes this read across cards).
  const { data: slot0Raw } = useReadContract({
    address: pool.address,
    abi: uniswapV3PoolAbi,
    functionName: 'slot0',
    chainId: arcTestnet.id,
  });
  const currentTick = decodeSlot0(slot0Raw)?.tick;

  const spacing = tickSpacingForFee(pool.feeTier);
  // Full range is a pure tick-space property; the band's human prices need the pool's orientation.
  const fullRange = isFullRangeTicks(position.tickLower, position.tickUpper, spacing);
  const band = !fullRange
    ? bandLabel(
        position.tickLower,
        position.tickUpper,
        baseIsToken0 ? baseDecimals : quoteDecimals,
        baseIsToken0 ? quoteDecimals : baseDecimals,
        baseIsToken0,
      )
    : undefined;
  const status =
    currentTick !== undefined
      ? tickRangeStatus(currentTick, position.tickLower, position.tickUpper)
      : undefined;
  const inRange = status === 'in-range';

  return (
    <div
      data-testid={`liquidity-row-${id}`}
      className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface px-4 py-3.5 transition-shadow hover:shadow-cardhover"
    >
      <div className="flex min-w-0 items-center gap-3">
        <TokenPairGlyph baseSymbol={baseSymbol} quoteSymbol={quoteSymbol} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-display text-[15px] font-semibold text-ink">{pair}</span>
            {/* Fee-tier badge (mirrors Uniswap's "0.3%" pill). */}
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-soft">
              {formatBps(ENV.FEE_TIER / 100)}
            </span>
            {/* The position's REAL price band: "Full range" or "min - max USDC" from its ticks. */}
            <span
              data-testid={`range-badge-${id}`}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-2 py-0.5 font-mono text-[11px] font-medium text-ink-soft"
            >
              {fullRange ? 'Full range' : band ? `${band} ${quoteSymbol}` : '…'}
            </span>
            {/* In/out-of-range status vs the pool's CURRENT tick (out of range = earning no fees). */}
            {status !== undefined && (
              <span
                data-testid={`range-status-${id}`}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
                  inRange
                    ? 'bg-side-up-soft text-side-up ring-side-up-ring'
                    : 'bg-amber-400/10 text-amber-700 ring-amber-400/30 dark:text-amber-300',
                )}
              >
                {inRange ? 'In range' : 'Out of range - earning no fees'}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className="font-mono text-ink-muted">#{id}</span>
            <span aria-hidden="true" className="text-ink-faint">
              ·
            </span>
            <EstimatedReturn position={position} pool={pool} />
          </div>
          {/* Unclaimed trading fees this position has earned. Claimable on their own via Collect fees,
              but ALSO already counted in the "Withdraw returns" amount above - so withdrawing never
              loses them. We say so inline because users assumed Withdraw dropped the fees. */}
          <div data-testid={`fees-${id}`} className="mt-0.5 text-xs">
            <span className="font-mono text-ink-muted">Unclaimed fees: </span>
            {hasFees ? (
              <>
                <span className="font-mono font-medium text-side-up">
                  ≈ {formatBase(feeBase, baseDecimals)} {baseSymbol} + {formatUSDC(feeUsdc)} {quoteSymbol}
                </span>
                <span className="text-ink-faint"> · already included in the Withdraw amount above</span>
              </>
            ) : (
              <span className="font-mono text-ink-faint">none yet</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          {/* Claim accrued trading fees WITHOUT withdrawing - the "claim" for liquidity-only LPs. */}
          <button
            type="button"
            data-testid={`collect-${id}`}
            disabled={isCollecting || !hasFees}
            onClick={() => void collect({ tokenId: position.tokenId })}
            className={buttonClass('primary', 'sm')}
            title={
              hasFees
                ? 'Take only the earned fees to your wallet - keeps your liquidity in place so it keeps earning. (Withdraw already includes these fees.)'
                : 'No fees to collect yet'
            }
          >
            {isCollecting ? (
              <>
                <Spinner className="h-3.5 w-3.5" /> Collecting…
              </>
            ) : (
              'Collect fees'
            )}
            <Stars />
          </button>
          <button
            type="button"
            data-testid={`withdraw-${id}`}
            disabled={isPending}
            onClick={() => void remove({ tokenId: position.tokenId })}
            className={buttonClass('secondary', 'sm')}
            title="Withdraw 100% of your liquidity PLUS all unclaimed fees to your wallet, in one transaction"
          >
            {isPending ? (
              <>
                <Spinner className="h-3.5 w-3.5" /> Withdrawing…
              </>
            ) : (
              'Withdraw'
            )}
            <Stars />
          </button>
        </div>
        {(hash || collectHash) && (
          <a
            href={`${ENV.EXPLORER_URL}/tx/${collectHash ?? hash}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
          >
            View on ArcScan <External className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Uniswap's empty / disconnected Pool state: a centered card with a wallet icon tile, a short headline +
 * message, a grey "New position" button (reveals the Create-position form) and - when disconnected - the
 * pink "Connect wallet" control. `onNewPosition` is wired by the page to reveal <ProvideLiquidity/>.
 */
function EmptyState({
  testId,
  message,
  showConnect,
  onNewPosition,
}: {
  testId: string;
  message: string;
  showConnect: boolean;
  onNewPosition?: () => void;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center justify-center px-6 py-14 text-center"
    >
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-muted text-ink-soft">
        <Wallet className="h-7 w-7" />
      </span>
      <h3 className="mt-5 font-display text-lg font-semibold text-ink">
        {showConnect ? 'Connect your wallet' : 'No open positions'}
      </h3>
      <p className="mt-1.5 max-w-sm text-sm text-ink-soft">{message}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
        {onNewPosition && (
          <button
            type="button"
            data-testid="your-liquidity-new-position"
            onClick={onNewPosition}
            className={buttonClass('subtle', 'md')}
          >
            <Plus className="h-4 w-4" /> New position
          </button>
        )}
        {showConnect && <Connect />}
      </div>
    </div>
  );
}

export function YourLiquidity({
  pool,
  onNewPosition,
}: {
  /** The selected pool (pair) - the list + per-card labels/orientation are scoped to it. */
  pool: PoolInfo;
  onNewPosition?: () => void;
}) {
  const { isConnected } = useAccount();
  const { data: positions, isLoading } = useOwnedPositions({ pool });

  const hasPositions = isConnected && !isLoading && !!positions && positions.length > 0;

  return (
    <Card className={cn('overflow-hidden', !hasPositions && 'bg-surface')}>
      <div data-testid="your-liquidity">
        {!isConnected ? (
          <EmptyState
            testId="your-liquidity-disconnected"
            showConnect
            message="Connect your wallet to view your positions and the trading fees they've earned."
            onNewPosition={onNewPosition}
          />
        ) : isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-20 w-full rounded-2xl" />
            <Skeleton className="h-20 w-full rounded-2xl" />
          </div>
        ) : !positions || positions.length === 0 ? (
          <EmptyState
            testId="your-liquidity-empty"
            showConnect={false}
            message="No open positions yet. Open a new position to start earning a share of swap fees. Staked positions do not appear here until they are unstaked or settled."
            onNewPosition={onNewPosition}
          />
        ) : (
          <div className="space-y-2.5 p-3 sm:p-4">
            {positions.map((p) => (
              <PositionCard key={p.tokenId.toString()} position={p} pool={pool} />
            ))}
            <p className="flex items-start gap-1.5 px-1 pt-1 text-xs text-ink-faint">
              <ArrowDown className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong className="font-medium text-ink-soft">Withdraw</strong> sends your liquidity{' '}
                <strong className="font-medium text-ink-soft">and all unclaimed fees</strong> to your wallet
                in one transaction - you never have to Collect first, and withdrawing never leaves fees
                behind. <strong className="font-medium text-ink-soft">Collect fees</strong> is optional: it
                takes only the earned fees and leaves your liquidity in place so it keeps earning. Staked
                positions are excluded until you unstake them.
              </span>
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
