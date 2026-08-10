// lib/positions.ts — pure filtering for Arena-stakeable V3 positions. No wagmi/ENV here so it
// stays trivially unit-testable; the hook (useOwnedPositions) wires the chain reads around it.
import type { OwnedPosition } from '@/lib/types';

/**
 * The subset of NPM.positions(tokenId) we need to decide stakeability, plus the tokenId itself.
 * `token0`/`token1` are the pool token addresses, `fee` the pool fee tier, `liquidity` the LP amount,
 * `tickLower`/`tickUpper` the position's price band (carried through for the range badges — they do
 * NOT affect the filter: the v1 arena accepts any range, in-range gating happens at sweep time).
 */
export interface RawPosition {
  tokenId: bigint;
  token0: string;
  token1: string;
  fee: number;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

/** Arena pool identity: the unordered {weth, usdc} pair at a specific fee tier. */
export interface ArenaPoolConfig {
  weth: string;
  usdc: string;
  feeTier: number;
}

/** Unordered, case-insensitive comparison of a position's pair against the target pair. */
function isSamePair(token0: string, token1: string, a: string, b: string): boolean {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return (t0 === x && t1 === y) || (t0 === y && t1 === x);
}

/**
 * Filter raw enumerated positions down to the connected wallet's stakeable Arena positions:
 *   - token pair == unordered {weth, usdc} (case-insensitive)
 *   - fee == feeTier
 *   - liquidity > 0
 *   - tokenId not already staked by this user
 * Range ticks pass through untouched (any range is stakeable — the badges, not the filter, surface
 * out-of-range risk). Returns the minimal `OwnedPosition[]` PositionPicker consumes, preserving order.
 */
export function filterArenaPositions(
  positions: readonly RawPosition[],
  cfg: ArenaPoolConfig,
  stakedTokenIds: readonly bigint[],
): OwnedPosition[] {
  const staked = new Set(stakedTokenIds.map((id) => id.toString()));
  return positions
    .filter(
      (p) =>
        p.liquidity > 0n &&
        p.fee === cfg.feeTier &&
        isSamePair(p.token0, p.token1, cfg.weth, cfg.usdc) &&
        !staked.has(p.tokenId.toString()),
    )
    .map((p) => ({
      tokenId: p.tokenId,
      liquidity: p.liquidity,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
    }));
}
