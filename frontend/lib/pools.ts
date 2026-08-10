// lib/pools.ts — the Uniswap-V3-fork pool registry for the token-pair Swap + pool-selectable LP. Each
// pool is the 0.3% fee tier on Arc. The cirBTC/USDC pool comes from ENV (the original market pool); the
// EURC/USDC and cirBTC/EURC pools are fixed Arc deployments (created by script/DeployV3Market.s.sol).
//
// A "pair" is order-independent; `findPool` matches either ordering. `token0/token1` are the ADDRESS-
// SORTED legs (how the V3 pool stores them) so swap-direction (zeroForOne) + LP amount mapping are exact.

import { ENV } from '@/lib/env';
import { CIRBTC, USDC, EURC, sortTokens, type TokenInfo } from '@/lib/tokens';

export interface PoolInfo {
  /** Stable id for UI keys. */
  id: string;
  address: `0x${string}`;
  feeTier: number;
  /** The two tokens, ADDRESS-SORTED: token0 = lower address, token1 = higher (matches the V3 pool). */
  token0: TokenInfo;
  token1: TokenInfo;
  /**
   * Semantic BASE leg — the volatile / primary token, priced as "X quote per base" (cirBTC, or EURC in
   * the EURC/USDC pair). This is a config designation, NOT "the non-USDC leg": cirBTC/EURC has no USDC
   * leg at all, so base/quote must be declared, not inferred. LP UIs read base/quote (never assume USDC).
   */
  base: TokenInfo;
  /** Semantic QUOTE leg — the stable / secondary token (USDC, or EURC in cirBTC/EURC). */
  quote: TokenInfo;
  /** True when `base` sorts as the pool's token0 (address-sorted) — maps (amount0,amount1) ↔ (base,quote). */
  baseIsToken0: boolean;
}

/** Build a pool from its semantic (base, quote) legs; token0/token1 are derived by address sort. */
function pool(id: string, address: `0x${string}`, base: TokenInfo, quote: TokenInfo): PoolInfo {
  const [token0, token1] = sortTokens(base, quote);
  return {
    id,
    address,
    feeTier: ENV.FEE_TIER,
    token0,
    token1,
    base,
    quote,
    baseIsToken0: base.address.toLowerCase() === token0.address.toLowerCase(),
  };
}

export const POOLS: PoolInfo[] = [
  pool('cirbtc-usdc', ENV.POOL_ADDRESS, CIRBTC, USDC),
  pool('eurc-usdc', '0xB89700608231C5D74b56308D2c96c5F830a5f322', EURC, USDC),
  pool('cirbtc-eurc', '0xEBCc92862e007220A90b407f92E90dAC3A98aD63', CIRBTC, EURC),
];

/** A human pair label, base first ("cirBTC / USDC"). */
export function poolLabel(p: PoolInfo): string {
  return `${p.base.symbol} / ${p.quote.symbol}`;
}

/** Lookup a pool by its stable id (the Pool-page pair selector keys on this). */
export function poolById(id: string): PoolInfo | undefined {
  return POOLS.find((p) => p.id === id);
}

/**
 * Resolve the registry pool an enumerated V3 position belongs to, by its (unordered) token pair + fee
 * tier. Used to label/withdraw positions across all pairs. Returns undefined for a non-registry pool.
 */
export function poolForPosition(
  token0: string,
  token1: string,
  feeTier: number,
): PoolInfo | undefined {
  const a = token0.toLowerCase();
  const b = token1.toLowerCase();
  return POOLS.find(
    (p) =>
      p.feeTier === feeTier &&
      ((p.token0.address.toLowerCase() === a && p.token1.address.toLowerCase() === b) ||
        (p.token0.address.toLowerCase() === b && p.token1.address.toLowerCase() === a)),
  );
}

/** Does this pool contain `t`? */
function poolHas(p: PoolInfo, t: TokenInfo): boolean {
  const a = t.address.toLowerCase();
  return p.token0.address.toLowerCase() === a || p.token1.address.toLowerCase() === a;
}

/** Find the pool for an (unordered) token pair, or undefined if no direct pool exists. */
export function findPool(a: TokenInfo, b: TokenInfo): PoolInfo | undefined {
  if (a.address.toLowerCase() === b.address.toLowerCase()) return undefined;
  return POOLS.find((p) => poolHas(p, a) && poolHas(p, b));
}

/** The set of tokens that have a direct pool with `t` (for building a valid "other token" picker). */
export function pairableTokens(t: TokenInfo): TokenInfo[] {
  const out: TokenInfo[] = [];
  for (const p of POOLS) {
    if (!poolHas(p, t)) continue;
    const other = p.token0.address.toLowerCase() === t.address.toLowerCase() ? p.token1 : p.token0;
    if (!out.some((x) => x.address.toLowerCase() === other.address.toLowerCase())) out.push(other);
  }
  return out;
}
