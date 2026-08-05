// lib/tokens.ts - the canonical token registry for the multi-asset DEX surfaces (Swap + Pool LP).
// Three Arc-testnet tokens: cirBTC (the volatile base, 8dp), USDC (6dp) and Circle EURC (6dp). Addresses
// come from validated ENV so nothing is hardcoded per-deployment. The arena (markets.ts) is a SEPARATE,
// arena-centric concept; this registry powers the token-pair swap + pool-selectable LP.

import { ENV } from '@/lib/env';

export interface TokenInfo {
  symbol: string;
  /** ERC-20 address on Arc. */
  address: `0x${string}`;
  decimals: number;
}

// cirBTC is stored under WETH_ADDRESS by history (the non-USDC base leg); USDC + EURC are explicit.
export const CIRBTC: TokenInfo = { symbol: 'cirBTC', address: ENV.WETH_ADDRESS, decimals: 8 };

// Circle USDC - Arc's native gas token and our quote/settlement asset. The ERC-20 view sits behind the
// 0x3600… facade at 6 decimals (the native gas balance is 18dp; we read decimals() and never assume).
// Every swap, LP add, stake and payout clears in USDC.
export const USDC: TokenInfo = { symbol: 'USDC', address: ENV.USDC_ADDRESS, decimals: 6 };

// Circle EURC - the euro stablecoin. Backs the cirBTC/EURC market, which settles in EUR off the BTC/EUR
// cross, so entries and payouts there are denominated in EURC. 6 decimals, same plumbing as USDC.
export const EURC: TokenInfo = { symbol: 'EURC', address: ENV.EURC_ADDRESS, decimals: 6 };

/** All swappable/LP-able tokens, in display order. */
export const TOKENS: TokenInfo[] = [CIRBTC, USDC, EURC];

/** Lookup a token by (case-insensitive) address. */
export function tokenByAddress(address: string): TokenInfo | undefined {
  const a = address.toLowerCase();
  return TOKENS.find((t) => t.address.toLowerCase() === a);
}

/** Lookup a token by symbol. */
export function tokenBySymbol(symbol: string): TokenInfo | undefined {
  return TOKENS.find((t) => t.symbol === symbol);
}

/**
 * Resolve a market's quote token from its `quoteSymbol` ('USDC' | 'EURC'). Defaults to USDC when
 * absent/unknown - so existing USDC-quoted arenas are unchanged. Both quotes are 6dp.
 */
export function quoteToken(quoteSymbol?: string): TokenInfo {
  return (quoteSymbol && tokenBySymbol(quoteSymbol)) || USDC;
}

/** Uniswap V3 sorts a pair by address; token0 is the lower address. Pure helper used by pool math. */
export function sortTokens(a: TokenInfo, b: TokenInfo): [TokenInfo, TokenInfo] {
  return a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];
}
