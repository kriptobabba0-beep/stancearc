'use client';

// components/arena/usePositionRange.ts — derive a position's human price band + in/out-of-range status
// from its ticks and the live pool price. Mirrors PositionPicker's range logic so the Arena rail/modals
// describe a position identically ("Full range" or "min – max USDC", plus whether it's currently in
// range). Orientation (baseIsToken0) and decimals come from the live pool — never hardcoded.
import { useReadContract } from 'wagmi';
import { useActiveBaseToken } from '@/hooks/useActiveBaseToken';
import { tickSpacingForFee } from '@/hooks/useMintPosition';
import { useMarketContracts } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';
import { ENV } from '@/lib/env';
import { tickRangeStatus } from '@/lib/rangeMath';
import { bandLabel, decodeSlot0, isFullRangeTicks } from '@/lib/rangeDisplay';
import type { OwnedPosition } from '@/lib/types';

const USDC_DECIMALS = 6;

export interface PositionRange {
  /** "Full range" or "min – max USDC". "…" while the band can't be computed yet. */
  label: string;
  /** 'in-range' | 'below' | 'above' | undefined (slot0 not yet known). */
  status: 'in-range' | 'below' | 'above' | undefined;
  /** True when the live price sits outside the band (no fees / no arena contribution). */
  outOfRange: boolean;
  /** True when the band is the full ±887k range. */
  fullRange: boolean;
}

export function usePositionRange(position?: OwnedPosition): PositionRange | undefined {
  const { baseIsToken0, decimals: baseDecimals } = useActiveBaseToken();
  const { pool } = useMarketContracts();
  const { data: slot0Raw } = useReadContract({ ...pool, functionName: 'slot0', chainId: arcTestnet.id });

  if (!position) return undefined;

  const currentTick = decodeSlot0(slot0Raw)?.tick;
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

  const label = fullRange ? 'Full range' : band ? `${band} USDC` : '…';
  const outOfRange = status !== undefined && status !== 'in-range';

  return { label, status, outOfRange, fullRange };
}
