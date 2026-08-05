// lib/rangeDisplay.ts - RENDER-ONLY helpers shared by the range-aware liquidity UI
// (ProvideLiquidity / YourLiquidity / PositionPicker). Pure: no React, no chain reads, no hardcoded
// decimals or orientation - everything is parameterised, mirroring lib/rangeMath's contract.
//
// All prices here are DISPLAY-grade floats from rangeMath.tickToPrice ("quote per base", e.g. USDC
// per cirBTC, inversion already resolved). Token AMOUNTS never flow through this module - those stay
// bigint-exact in rangeMath.counterpartAmount.
import { maxUsableTick, tickToPrice } from '@/lib/rangeMath';

/**
 * True when [tickLower, tickUpper] covers the WHOLE usable range for the fee tier's spacing
 * (±maxUsableTick - e.g. ±887220 for spacing 60, mirroring fullRangeTicks/DeployMarket._seed).
 * Orientation/decimals-free: full range is a pure tick-space property.
 */
export function isFullRangeTicks(tickLower: number, tickUpper: number, spacing: number): boolean {
  const max = maxUsableTick(spacing);
  return tickLower <= -max && tickUpper >= max;
}

/**
 * Compact human price for range labels: thousands get grouping + no decimals ("63,750"), mid-range
 * keeps 2 decimals, sub-1 keeps 6; degenerate values collapse to "0"/"∞"/"<0.0001" so a full-range
 * tick never renders as a 38-digit number. Display only - NEVER parse this back (it contains commas).
 */
export function formatHumanPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '0';
  if (p >= 1e15) return '∞';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p < 1e-4) return '<0.0001';
  return p.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/**
 * The ORDERED human price band [min, max] for a tick range. tickToPrice is DECREASING in tick when
 * baseIsToken0=false (the live cirBTC/USDC inversion), so the endpoints are sorted here - callers
 * must never assume tickLower maps to the min price.
 */
export function bandPrices(
  tickLower: number,
  tickUpper: number,
  dec0: number,
  dec1: number,
  baseIsToken0: boolean,
): { min: number; max: number } {
  const a = tickToPrice(tickLower, dec0, dec1, baseIsToken0);
  const b = tickToPrice(tickUpper, dec0, dec1, baseIsToken0);
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

/** "min - max" human price band label for a tick range (ordered, compact-formatted). */
export function bandLabel(
  tickLower: number,
  tickUpper: number,
  dec0: number,
  dec1: number,
  baseIsToken0: boolean,
): string {
  const { min, max } = bandPrices(tickLower, tickUpper, dec0, dec1, baseIsToken0);
  return `${formatHumanPrice(min)} - ${formatHumanPrice(max)}`;
}

/**
 * Decode a pool slot0() read into { sqrtPriceX96, tick }. viem 2.19.4 decodes the flat multi-output
 * positionally (an array: [0]=sqrtPriceX96, [1]=tick) - named fallbacks keep this robust to either
 * decode shape (same pattern as SwapForm / useOwnedPositions). Returns undefined while loading or on
 * a malformed read so callers can render a loading state instead of a wrong price.
 */
export function decodeSlot0(slot0: unknown): { sqrtPriceX96: bigint; tick: number } | undefined {
  if (!slot0) return undefined;
  const named = slot0 as { sqrtPriceX96?: bigint; tick?: number | bigint };
  const arr = Array.isArray(slot0) ? (slot0 as readonly unknown[]) : undefined;
  const sqrt = named.sqrtPriceX96 ?? arr?.[0];
  const tick = named.tick ?? arr?.[1];
  if (typeof sqrt !== 'bigint' || sqrt <= 0n) return undefined;
  if (typeof tick !== 'number' && typeof tick !== 'bigint') return undefined;
  return { sqrtPriceX96: sqrt, tick: Number(tick) };
}
