// lib/decimals.ts — boot decimals read + hard-fail assert (USDC===6 only); caches values.
// Mirrors the FeeArena constructor BadDecimals assert, which only constrains the USDC leg. The base
// leg is DECIMALS-AGNOSTIC on-chain (winner = liquidity*tickSpan; resolution on the 18-dp oracle), so
// the flagship cirBTC market boots with an 8-dp base. price decimals are the 18-dp oracle quote scale.
import type { BootDecimals } from '@/lib/types';

let cached: BootDecimals | null = null;

/**
 * Pure assert: throws (hard-fail) ONLY when usdc !== 6. The second argument is the observed BASE-token
 * decimals (cirBTC=8, WETH=18, …); it is NOT gated — the contract is base-decimals-agnostic, so any
 * value is accepted and the app boots regardless. Returns the frozen BootDecimals.
 *
 * NOTE: the returned `weth: 18` is a vestigial constant kept only so `wethNotionalDiv` (lib/money.ts —
 * used in tests, never in a live render path) stays type-stable. It does NOT reflect the base token's
 * real decimals and is not consumed anywhere that renders.
 */
export function assertBootDecimals(usdcDecimals: number, _baseDecimals: number): BootDecimals {
  if (usdcDecimals !== 6) {
    throw new Error(`[boot] BadDecimals: USDC.decimals() must be 6, got ${usdcDecimals}`);
  }
  // base leg intentionally unchecked — see fn doc (decimals-agnostic; 8-dp cirBTC must boot).
  return Object.freeze({ usdc: 6, weth: 18, price: 18 }) as BootDecimals;
}

export function setBootDecimals(d: BootDecimals): void {
  cached = d;
}

/** Throws if the boot gate has not passed yet. */
export function getBootDecimals(): BootDecimals {
  if (cached === null) throw new Error('[boot] decimals gate has not passed — call setBootDecimals first');
  return cached;
}

export function isBootDecimalsReady(): boolean {
  return cached !== null;
}

/** Test-only reset of the module cache. */
export function __resetBootDecimalsForTest(): void {
  cached = null;
}
