// lib/rangeChartMath.ts — PURE geometry for the draggable range chart (no React, no chain reads). The
// chart's x-axis is LINEAR IN HUMAN PRICE (quote per base, e.g. USDC per cirBTC) so it matches the
// reference's evenly-spaced price ticks. The canonical liquidity range is always TICK space — the chart
// converts price↔tick at the edges (via lib/rangeMath customTicks / bandPrices), so the cirBTC/USDC
// inversion (baseIsToken0=false) is resolved there, never here.
//
// Display-grade floats throughout: handle positions, the depth backdrop and the APR estimate are all
// visual aids. The mint amounts stay bigint-exact in lib/rangeMath.counterpartAmount.
import { maxUsableTick } from '@/lib/rangeMath';

/** A visible price window [min, max] for the chart x-axis. */
export interface PriceDomain {
  min: number;
  max: number;
}

/**
 * A symmetric-in-ratio price window around `current`, widened by `zoom` (fraction). zoom 0.4 →
 * [current/1.4, current×1.4]. Clamped to a positive min. A non-positive/!finite current falls back to
 * a unit window so the chart still renders (loading state).
 */
export function makeDomain(current: number, zoom: number): PriceDomain {
  if (!(current > 0) || !Number.isFinite(current)) return { min: 0, max: 1 };
  const z = Math.max(0.05, Math.min(4, zoom));
  return { min: current / (1 + z), max: current * (1 + z) };
}

/** Human price → x pixel (linear in price), clamped to [0, width]. */
export function priceToX(price: number, domain: PriceDomain, width: number): number {
  const { min, max } = domain;
  if (max <= min) return 0;
  const x = ((price - min) / (max - min)) * width;
  return Math.max(0, Math.min(width, x));
}

/** x pixel → human price (inverse of priceToX), clamped to the domain. */
export function xToPrice(x: number, domain: PriceDomain, width: number): number {
  const { min, max } = domain;
  if (width <= 0) return min;
  const clampedX = Math.max(0, Math.min(width, x));
  return min + (clampedX / width) * (max - min);
}

/** Fraction [0,1] of a price across the domain (for % width / CSS left positioning). */
export function priceToFraction(price: number, domain: PriceDomain): number {
  const { min, max } = domain;
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (price - min) / (max - min)));
}

/**
 * Signed % of `price` away from `current` ( (price/current − 1) × 100 ). Drives the "−10.11% / +9.90%"
 * labels on the handles. Returns 0 for a non-positive current.
 */
export function pctFromCurrent(price: number, current: number): number {
  if (!(current > 0)) return 0;
  return (price / current - 1) * 100;
}

/**
 * A stylised concentrated-liquidity DEPTH backdrop: `bars` heights in [0,1] forming a smooth hump that
 * peaks at the current price and tapers toward the domain edges (a gaussian in log-price). This is a
 * VISUAL aid for choosing a band — it is not a claim of exact per-tick on-chain liquidity (which would
 * cost hundreds of reads on a thin pool). Deterministic (no randomness) so it's stable across renders.
 */
export function depthBars(domain: PriceDomain, current: number, bars: number): number[] {
  const out = new Array<number>(Math.max(0, bars)).fill(0);
  if (bars <= 0 || domain.max <= domain.min || !(current > 0)) return out;
  // Width of the hump, in the same log-price units used below (~ the visible window's half-width).
  const sigma = Math.log(domain.max / domain.min) / 5;
  for (let i = 0; i < bars; i++) {
    // Center each bar in its slot and read its price.
    const frac = (i + 0.5) / bars;
    const price = domain.min + frac * (domain.max - domain.min);
    if (price <= 0) continue;
    const d = Math.log(price / current) / sigma;
    out[i] = Math.exp(-0.5 * d * d);
  }
  // Normalise so the tallest bar is 1.
  const peak = Math.max(...out, 1e-9);
  return out.map((h) => h / peak);
}

/**
 * Capital-efficiency boost of a band vs full range, as a rough multiple = fullTickWidth / bandTickWidth,
 * clamped to [1, cap]. A tighter band concentrates the same liquidity, so it earns a larger share of
 * fees while in range — this is the standard intuition, surfaced as an ESTIMATE (not a guarantee).
 */
export function concentrationBoost(
  tickLower: number,
  tickUpper: number,
  spacing: number,
  cap = 1000,
): number {
  const band = tickUpper - tickLower;
  if (!(band > 0)) return 1;
  const full = 2 * maxUsableTick(spacing);
  return Math.max(1, Math.min(cap, full / band));
}

/**
 * Estimated APR (%) for a chosen band = the pool's real full-range fee APR × the concentration boost.
 * Display-only ("Estimated APR"): it scales the honest pool APR by how tightly the band concentrates
 * liquidity. Full range → boost 1 → the pool's own APR.
 */
export function rangeAprEstimate(
  basePoolAprPct: number,
  tickLower: number,
  tickUpper: number,
  spacing: number,
): number {
  if (!Number.isFinite(basePoolAprPct) || basePoolAprPct <= 0) return 0;
  return basePoolAprPct * concentrationBoost(tickLower, tickUpper, spacing);
}
