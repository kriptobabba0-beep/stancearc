// lib/contracts.ts — typed contract handles (address + abi).
//
// TWO tiers:
//  1. SHARED INFRA (global, one per chain): USDC, router, NPM, factory, multicall, Pyth contract.
//     These come straight from validated ENV and are the same across all markets.
//  2. PER-MARKET (FeeArena / oracle / pool): resolved from the ACTIVE market via useMarketContracts().
//     Each market is an independent FeeArena + PythPriceOracle + V3 pool (see lib/markets.ts).
import { ENV } from '@/lib/env';
import { MARKETS, isV2Market, isV3Market, type Market } from '@/lib/markets';
import { useActiveMarket } from '@/components/MarketProvider';
import {
  feeArenaAbi, feeArenaV2Abi, feeArenaV3Abi, feeArenaV2LensAbi, mockPriceOracleAbi, pythAbi,
  nonfungiblePositionManagerAbi, swapRouterAbi, uniswapV3PoolAbi, uniswapV3FactoryAbi,
  erc20Abi, erc721Abi,
} from '@/abis';

// ── Shared infra (global) ─────────────────────────────────────────────────────
// Pyth pull-oracle: getUpdateFee (to value the start/end crank) + getPriceUnsafe (live read).
export const pythContract = { address: ENV.PYTH_ADDRESS, abi: pythAbi } as const;
export const npm = { address: ENV.NPM_ADDRESS, abi: nonfungiblePositionManagerAbi } as const;
export const swapRouter = { address: ENV.SWAP_ROUTER_ADDRESS, abi: swapRouterAbi } as const;
export const factory = { address: ENV.FACTORY_ADDRESS, abi: uniswapV3FactoryAbi } as const;
export const usdc = { address: ENV.USDC_ADDRESS, abi: erc20Abi } as const; // ERC-20 USDC (6dp)
export const eurc = { address: ENV.EURC_ADDRESS, abi: erc20Abi } as const; // Circle EURC (6dp) — euro stablecoin on Arc
export const weth = { address: ENV.WETH_ADDRESS, abi: erc20Abi } as const; // WETH9 test token (18dp)
export const positionNft = { address: ENV.NPM_ADDRESS, abi: erc721Abi } as const;

export const MULTICALL3_ADDRESS = ENV.MULTICALL3_ADDRESS;

/** Alias used by PositionPicker / P-group components. */
export const npmContract = npm;

// ── Per-market contract config ─────────────────────────────────────────────────

/** The arena ABI a market binds to — v2 -> FeeArenaV2, v3 -> FeeArenaV3 (entry-anchored), else v1. */
export type FeeArenaAbi = typeof feeArenaAbi | typeof feeArenaV2Abi | typeof feeArenaV3Abi;

export interface MarketContracts {
  /**
   * The market's FeeArena. For a v2 market `abi` is feeArenaV2Abi (stakeWithConviction / claim+refund
   * with recipient / withdrawCredited); otherwise feeArenaAbi (v1).
   */
  feeArena: { address: `0x${string}`; abi: FeeArenaAbi };
  oracle: { address: `0x${string}`; abi: typeof mockPriceOracleAbi };
  pool: { address: `0x${string}`; abi: typeof uniswapV3PoolAbi };
  /**
   * The FeeArenaV2Lens (read/preview surface). Present ONLY for v2 markets — the frontend reads
   * previewClaim / previewRefund / getStake / getStakesByEpoch from here, not from the arena.
   */
  lens?: { address: `0x${string}`; abi: typeof feeArenaV2LensAbi };
}

/** Build the FeeArena/oracle/pool (+ v2 Lens) handles for a market (pure — used by hooks + non-React code). */
export function marketContracts(market: Market): MarketContracts {
  const v2 = isV2Market(market);
  const v3 = isV3Market(market);
  return {
    feeArena: { address: market.feeArena, abi: v2 ? feeArenaV2Abi : v3 ? feeArenaV3Abi : feeArenaAbi },
    oracle: { address: market.oracle, abi: mockPriceOracleAbi },
    pool: { address: market.pool, abi: uniswapV3PoolAbi },
    ...(v2 && market.lens ? { lens: { address: market.lens, abi: feeArenaV2LensAbi } } : {}),
  };
}

/** The FeeArena/oracle/pool contract configs for the ACTIVE market (re-points when the selector changes). */
export function useMarketContracts(): MarketContracts {
  const market = useActiveMarket();
  return marketContracts(market);
}

/**
 * The STAKE/PREVIEW read surface for a market. v2 moved getStake / getStakesByEpoch / previewClaim /
 * previewRefund OFF the arena and onto the FeeArenaV2Lens — the arena has none of them. v1 keeps them
 * on the arena. So hooks that read stakes/previews must target THIS handle, not `feeArena`:
 *   - v2  -> the Lens (feeArenaV2LensAbi @ market.lens)
 *   - v1  -> the arena (feeArenaAbi @ market.feeArena)
 * The signatures + decoded tuples (StakeView / ClaimPreview) are identical across the two, so callers
 * decode the same shape regardless of version.
 */
export type ReadSurface =
  | { address: `0x${string}`; abi: typeof feeArenaV2LensAbi }
  | { address: `0x${string}`; abi: typeof feeArenaAbi }
  | { address: `0x${string}`; abi: typeof feeArenaV3Abi };

/** Pure: pick the stake/preview read surface (Lens for v2, the arena itself for v1/v3). */
export function readSurface(contracts: MarketContracts): ReadSurface {
  if (contracts.lens) return contracts.lens; // v2: previews/stake listings live on the Lens
  // v1/v3: the arena carries getStake(sByEpoch)/previewClaim/getUserStakes itself. The arena `abi`
  // is the v1|v2|v3 union; for a non-v2 market it is concretely the v1 or v3 ABI, both of which are
  // ReadSurface members — cast through unknown since a union value isn't structurally a union type.
  return contracts.feeArena as unknown as ReadSurface;
}

/** The active market's stake/preview read surface (Lens for v2, arena for v1). */
export function useReadSurface(): ReadSurface {
  return readSurface(useMarketContracts());
}

// ── Back-compat default-market handles ─────────────────────────────────────────
// The DEFAULT market's FeeArena/oracle/pool, for the few non-React call sites (lib/events.ts default
// path) and to preserve the original `feeArena`/`oracle`/`pool` exports. With NEXT_PUBLIC_MARKETS
// unset these equal the original ENV-derived addresses, so today's single-market behavior is unchanged.
const defaultMarketContracts = marketContracts(MARKETS[0]);
export const feeArena = defaultMarketContracts.feeArena;
export const oracle = defaultMarketContracts.oracle;
export const pool = defaultMarketContracts.pool;
