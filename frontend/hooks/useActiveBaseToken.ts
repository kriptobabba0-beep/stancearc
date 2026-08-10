// hooks/useActiveBaseToken.ts — resolve the ACTIVE market's base token from the live pool.
//
// The active market's pool is a {base, USDC} V3 pool whose token0/token1 are address-sorted on-chain,
// so the base leg is NOT statically known to be token0 (USDC can sort first). This hook reads the
// active pool's token0()/token1() and reports:
//   - address:      the non-USDC leg (the base token, e.g. WETH or WBTC)
//   - decimals:     market.baseDecimals (WETH 18, WBTC 8, …) — from the market config, not on-chain
//   - symbol:       market.baseSymbol
//   - baseIsToken0: whether the base leg sorts as token0 (USDC is token1) — mirrors the contract's
//                   wethIsToken0 remap, used to map address-sorted (amount0, amount1) tuples back to
//                   (baseLeg, usdcLeg).
//   - isLoading:    true while token0/token1 are still in flight (consumers must NOT assume the
//                   default ETH base while loading — see Fix E).
//
// Shared by the demo-swap runner (Fix B), PositionPicker fee ordering (Fix C), and useOwnedPositions
// filtering (Fix E).
import { useMemo } from 'react';
import { useReadContract } from 'wagmi';
import { useMarketContracts } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';
import { useActiveMarket } from '@/components/MarketProvider';
import { ENV } from '@/lib/env';

export interface ActiveBaseToken {
  /** The active pool's non-USDC leg (the base token address), or undefined while pool tokens load. */
  address: `0x${string}` | undefined;
  /** The active market's base decimals (config-sourced: WETH 18, WBTC 8). */
  decimals: number;
  /** The active market's base symbol (e.g. "WETH", "WBTC"). */
  symbol: string;
  /** True when the base leg sorts as the pool's token0 (USDC is token1). undefined while loading. */
  baseIsToken0: boolean | undefined;
  /** True while the active pool's token0()/token1() reads are in flight. */
  isLoading: boolean;
}

/**
 * Resolve the active market's base token from its live pool (token0/token1), classifying which leg
 * is the base vs USDC. Returns `address`/`baseIsToken0` = undefined and `isLoading` = true until both
 * pool reads resolve, so callers never transiently substitute the default ETH base on a non-ETH market.
 */
export function useActiveBaseToken(): ActiveBaseToken {
  const market = useActiveMarket();
  const { pool } = useMarketContracts();

  const { data: token0 } = useReadContract({ ...pool, functionName: 'token0', chainId: arcTestnet.id, query: { staleTime: 60_000 } });
  const { data: token1 } = useReadContract({ ...pool, functionName: 'token1', chainId: arcTestnet.id, query: { staleTime: 60_000 } });

  return useMemo<ActiveBaseToken>(() => {
    const usdcLc = ENV.USDC_ADDRESS.toLowerCase();
    const t0 = token0 as `0x${string}` | undefined;
    const t1 = token1 as `0x${string}` | undefined;

    // Until BOTH legs are known we cannot classify base vs USDC — report loading (no ETH fallback).
    if (!t0 || !t1) {
      return {
        address: undefined,
        decimals: market.baseDecimals,
        symbol: market.baseSymbol,
        baseIsToken0: undefined,
        isLoading: true,
      };
    }

    const baseIsToken0 = t0.toLowerCase() !== usdcLc;
    return {
      address: baseIsToken0 ? t0 : t1,
      decimals: market.baseDecimals,
      symbol: market.baseSymbol,
      baseIsToken0,
      isLoading: false,
    };
  }, [token0, token1, market.baseDecimals, market.baseSymbol]);
}
