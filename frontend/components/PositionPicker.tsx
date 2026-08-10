'use client';

// components/PositionPicker.tsx — the Arena stake picker: the wallet's stakeable positions, one row
// per position NFT with its live pending fees, its price RANGE ("Full range" or the "min – max USDC"
// band from its ticks) and an in/out-of-range hint. Out-of-range rows get an amber "no arena
// contribution" note but are NOT blocked — the v1 arena accepts any range (contribution is in-range
// gated at sweep time), so we inform rather than gate.
import { useAccount, useReadContract, useSimulateContract } from 'wagmi';
import { useOwnedPositions } from '@/hooks/useOwnedPositions';
import { useActiveBaseToken } from '@/hooks/useActiveBaseToken';
import { tickSpacingForFee } from '@/hooks/useMintPosition';
import { npmContract, useMarketContracts } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';
import { ENV } from '@/lib/env';
import { Skeleton } from '@/components/ui/Skeleton';
import { MoneyAmount, BaseAmount } from '@/components/MoneyAmount';
import { Check } from '@/components/ui/icons';
import { tickRangeStatus } from '@/lib/rangeMath';
import { bandLabel, decodeSlot0, isFullRangeTicks } from '@/lib/rangeDisplay';
import { cn } from '@/lib/cn';
import type { OwnedPosition } from '@/lib/types';

const MAX_UINT128 = (1n << 128n) - 1n;
// USDC is the global 6dp quote leg (same constant SwapForm/ProvideLiquidity use); the base leg's
// decimals come from useActiveBaseToken — never hardcoded.
const USDC_DECIMALS = 6;

interface PositionPickerProps {
  selectedTokenId?: bigint;
  onSelect: (tokenId: bigint) => void;
}

function PositionRow({
  position,
  selected,
  onSelect,
}: {
  position: OwnedPosition;
  selected: boolean;
  onSelect: (tokenId: bigint) => void;
}) {
  const { address } = useAccount();
  // npm.collect returns ADDRESS-SORTED (amount0, amount1) — the base leg is NOT necessarily token0
  // (USDC can sort first). Resolve which leg is the base for the active market and remap so the base
  // amount always renders via <BaseAmount/> (correct decimals: WETH 18 / WBTC 8) and USDC via
  // <MoneyAmount token="USDC"/>. Mirrors FeeArena.externalCollect's wethIsToken0 remap (Fix C).
  const { baseIsToken0, decimals: baseDecimals } = useActiveBaseToken();
  const { pool } = useMarketContracts();
  // Live pool tick for the in/out-of-range hint (wagmi dedupes this read across rows). isPending
  // distinguishes "still loading" from "failed/unavailable" for the fallback hint below.
  const { data: slot0Raw, isPending: slot0Pending } = useReadContract({
    ...pool,
    functionName: 'slot0',
    chainId: arcTestnet.id,
  });
  const currentTick = decodeSlot0(slot0Raw)?.tick;
  // Live pending fees: simulate collect(max,max). result = [amount0, amount1].
  const { data, isLoading } = useSimulateContract({
    ...npmContract,
    functionName: 'collect',
    args: [
      {
        tokenId: position.tokenId,
        recipient: address ?? '0x0000000000000000000000000000000000000000',
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
    ],
    account: address,
    chainId: arcTestnet.id,
    query: { enabled: Boolean(address) },
  });

  const [amount0, amount1] = (data?.result as readonly [bigint, bigint] | undefined) ?? [undefined, undefined];
  // Map the address-sorted tuple back to (base, USDC). While baseIsToken0 is still resolving
  // (undefined), default to base==token0 so the default ETH market (base IS token0) renders as before.
  const baseFee = baseIsToken0 === false ? amount1 : amount0;
  const usdcFee = baseIsToken0 === false ? amount0 : amount1;
  // The "loaded" gate keys off whichever leg the base maps to (so we don't flash a stale value).
  const baseLoaded = baseFee !== undefined;

  const id = position.tokenId.toString();
  // The position's price band ("Full range" or "min – max USDC") + where the live tick sits. Out of
  // range is informational only — staking stays allowed (the contract accepts any range).
  const spacing = tickSpacingForFee(ENV.FEE_TIER);
  const fullRange = isFullRangeTicks(position.tickLower, position.tickUpper, spacing);
  const band =
    !fullRange && baseIsToken0 !== undefined
      ? bandLabel(
          position.tickLower,
          position.tickUpper,
          baseIsToken0 ? baseDecimals : USDC_DECIMALS,
          baseIsToken0 ? USDC_DECIMALS : baseDecimals,
          baseIsToken0,
        )
      : undefined;
  const status =
    currentTick !== undefined
      ? tickRangeStatus(currentTick, position.tickLower, position.tickUpper)
      : undefined;
  const outOfRange = status !== undefined && status !== 'in-range';

  return (
    <button
      type="button"
      onClick={() => onSelect(position.tokenId)}
      data-testid={`position-${id}`}
      aria-pressed={selected}
      aria-label={`Select position #${id}`}
      className={cn(
        'flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-all duration-150 focus-visible:outline-none focus-visible:shadow-focus',
        selected
          ? 'border-brand bg-brand-soft ring-1 ring-brand-ring'
          : 'border-line bg-surface hover:border-line-strong hover:bg-surface-muted',
      )}
    >
      <span className="inline-flex items-center gap-2.5">
        <span
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors',
            selected ? 'border-brand bg-brand text-white' : 'border-line text-transparent',
          )}
        >
          <Check className="h-3 w-3" />
        </span>
        <span className="font-mono text-ink">#{id}</span>
      </span>
      <span className="flex flex-col items-end gap-0.5">
        <span className="font-mono text-xs text-ink-muted">
          {isLoading || !baseLoaded ? (
            'pending fees: …'
          ) : (
            <>
              pending fees: <BaseAmount value={baseFee} /> /{' '}
              <MoneyAmount value={usdcFee ?? 0n} token="USDC" />
            </>
          )}
        </span>
        <span data-testid={`position-range-${id}`} className="font-mono text-[11px] text-ink-faint">
          {fullRange ? 'Full range' : band ? `${band} USDC` : '…'}
          {status !== undefined && !outOfRange && ' · in range'}
          {/* No slot0 yet: say so explicitly instead of silently omitting the in/out-of-range hint
              ("…" while the read is in flight, an honest "unavailable" if it failed). */}
          {status === undefined && (slot0Pending ? ' · …' : ' · range status unavailable')}
        </span>
        {outOfRange && (
          <span
            data-testid={`position-range-oor-${id}`}
            className="text-[11px] font-medium text-amber-700 dark:text-amber-300"
          >
            out of range — no fees, no Stance contribution
          </span>
        )}
      </span>
    </button>
  );
}

export function PositionPicker({ selectedTokenId, onSelect }: PositionPickerProps) {
  const { data: positions, isLoading } = useOwnedPositions();

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!positions || positions.length === 0) {
    return (
      <div
        data-testid="position-picker-empty"
        className="rounded-xl border border-dashed border-line bg-surface-muted px-3.5 py-3 text-sm text-ink-muted"
      >
        <p>No stakeable Stance positions yet. (Already-staked positions are excluded.)</p>
        <a
          href="#provide-liquidity"
          className="mt-1.5 inline-flex items-center gap-1 rounded font-medium text-brand hover:text-brand-hover focus-visible:outline-none focus-visible:shadow-focus"
        >
          Provide liquidity to get a stakeable position →
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {positions.map((p) => (
        <PositionRow
          key={p.tokenId.toString()}
          position={p}
          selected={selectedTokenId === p.tokenId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
