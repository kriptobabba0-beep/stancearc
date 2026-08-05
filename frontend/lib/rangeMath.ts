// lib/rangeMath.ts - PURE tick/price/liquidity math for RANGE-SELECTABLE V3 positions (no React, no
// chain reads, no hardcoded decimals/orientation - everything is parameterised). This is the math
// foundation the range-picker UI builds on: preset/custom price bands → spacing-aligned ticks →
// bigint-exact counterpart amounts for the "one input drives the other" mint form.
//
// ── Orientation (the #1 correctness risk) ────────────────────────────────────────────────────────
// Uniswap's RAW price is always token1-raw per token0-raw: P_raw = (sqrtPriceX96/2^96)^2 = 1.0001^tick.
// The HUMAN price the user sees is "quote per base" (e.g. USDC per cirBTC):
//   - human token1-per-token0 = P_raw · 10^(dec0 − dec1)            (decimals shift)
//   - baseIsToken0  → humanPrice =     P_raw · 10^(dec0 − dec1)     (same direction as raw)
//   - !baseIsToken0 → humanPrice = 1 / (P_raw · 10^(dec0 − dec1))   (INVERTED: higher human price
//                                                                    = LOWER raw price = LOWER tick)
// Live cirBTC/USDC market: token0 = USDC (6dp), token1 = cirBTC (8dp), baseIsToken0 = false, so a
// human band [minPrice, maxPrice] in USDC-per-cirBTC maps to ticks with maxPrice → tickLower and
// minPrice → tickUpper. customTicks() handles that flip; never order ticks from prices by hand.
//
// ── Precision contract ───────────────────────────────────────────────────────────────────────────
// PRICES (display + tick selection) use float64: tick = round(ln(P_raw)/ln(1.0001)) is exact to far
// below one tick over the whole ±887272 domain, and ticks are then spacing-rounded anyway.
// AMOUNTS are bigint-exact: sqrtRatioAtTick() is the canonical Uniswap TickMath bit-shift algorithm
// (ported 1:1 from lib/v3-core TickMath.sol, validated against MIN/MAX_SQRT_RATIO in tests) and
// counterpartAmount() uses the canonical LiquidityAmounts relations with floor division.
//
// Q96 is imported from lib/swapQuote.ts (single source of truth for the X96 scale).
import { Q96 } from '@/lib/swapQuote';

// ── Canonical V3 tick bounds (TickMath.sol) ──────────────────────────────────────────────────────

/** TickMath.MIN_TICK - log base 1.0001 of 2^-128. */
export const MIN_TICK = -887272;
/** TickMath.MAX_TICK - log base 1.0001 of 2^128. */
export const MAX_TICK = 887272;
/** TickMath.MIN_SQRT_RATIO = getSqrtRatioAtTick(MIN_TICK) (test anchor for the bit-shift port). */
export const MIN_SQRT_RATIO = 4295128739n;
/** TickMath.MAX_SQRT_RATIO = getSqrtRatioAtTick(MAX_TICK) (test anchor for the bit-shift port). */
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const LOG_1_0001 = Math.log(1.0001);
const MAX_UINT256 = (1n << 256n) - 1n;

/** A spacing-aligned, validated [tickLower, tickUpper) range (always tickLower < tickUpper). */
export interface TickRange {
  tickLower: number;
  tickUpper: number;
}

function assertSpacing(spacing: number): void {
  if (!Number.isInteger(spacing) || spacing <= 0) {
    throw new Error(`[rangeMath] tick spacing must be a positive integer, got ${spacing}`);
  }
}

/**
 * Greatest usable tick for a fee tier: MAX_TICK truncated DOWN to a multiple of `spacing`
 * (Solidity `(887272 / spacing) * spacing` - e.g. spacing 60 → 887220). Mirrors useMintPosition's
 * fullRangeTicks and DeployMarket._seed.
 */
export function maxUsableTick(spacing: number): number {
  assertSpacing(spacing);
  return Math.trunc(MAX_TICK / spacing) * spacing;
}

/** Lowest usable tick for a fee tier (symmetric: −maxUsableTick, e.g. spacing 60 → −887220). */
export function minUsableTick(spacing: number): number {
  return -maxUsableTick(spacing);
}

// ── Tick ⇄ human price (decimals- and orientation-aware) ─────────────────────────────────────────

/** RAW price (token1-raw per token0-raw) → HUMAN "quote per base" price. Float - display grade. */
function rawToHumanPrice(rawPrice: number, dec0: number, dec1: number, baseIsToken0: boolean): number {
  // 1 human token0 = 10^dec0 raw → P_raw·10^dec0 raw token1 → /10^dec1 human token1.
  const humanToken1PerToken0 = rawPrice * Math.pow(10, dec0 - dec1);
  return baseIsToken0 ? humanToken1PerToken0 : 1 / humanToken1PerToken0;
}

/** HUMAN "quote per base" price → RAW price (token1-raw per token0-raw). Inverse of rawToHumanPrice. */
function humanToRawPrice(price: number, dec0: number, dec1: number, baseIsToken0: boolean): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`[rangeMath] price must be a finite positive number, got ${price}`);
  }
  return baseIsToken0 ? price * Math.pow(10, dec1 - dec0) : Math.pow(10, dec1 - dec0) / price;
}

/**
 * Tick → HUMAN price ("quote per base", e.g. USDC per cirBTC) as a JS number (display-grade - use
 * counterpartAmount, never this, for token amounts). P_raw = 1.0001^tick, then decimals-shift and
 * (when !baseIsToken0) invert. NOTE the inversion: with baseIsToken0=false this is DECREASING in
 * tick - a higher tick means a LOWER human price.
 */
export function tickToPrice(tick: number, dec0: number, dec1: number, baseIsToken0: boolean): number {
  return rawToHumanPrice(Math.pow(1.0001, tick), dec0, dec1, baseIsToken0);
}

/**
 * HUMAN price → NEAREST tick (round-to-nearest in log space, clamped to [MIN_TICK, MAX_TICK]).
 * Handles the inversion: with baseIsToken0=false a HIGHER human price maps to a LOWER tick (the raw
 * price is the reciprocal), so callers must NOT assume tick order follows price order - use
 * customTicks() to build a range from a price band. Throws on a non-finite or non-positive price.
 * Float tick selection is fine (ticks get spacing-rounded); amounts stay bigint elsewhere.
 */
export function priceToTick(price: number, dec0: number, dec1: number, baseIsToken0: boolean): number {
  const raw = humanToRawPrice(price, dec0, dec1, baseIsToken0);
  const tick = Math.round(Math.log(raw) / LOG_1_0001);
  return Math.min(MAX_TICK, Math.max(MIN_TICK, tick));
}

/**
 * Pool sqrtPriceX96 (slot0[0]) → HUMAN "quote per base" price as a JS number (display-grade).
 * P_raw = (sqrtPriceX96/Q96)^2, then the same decimals/orientation mapping as tickToPrice.
 * Returns 0 for a non-positive input (empty/uninitialised pool guard).
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  dec0: number,
  dec1: number,
  baseIsToken0: boolean,
): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const s = Number(sqrtPriceX96) / Number(Q96);
  return rawToHumanPrice(s * s, dec0, dec1, baseIsToken0);
}

// ── Spacing-correct range building ───────────────────────────────────────────────────────────────

/**
 * Align a raw [tickLower, tickUpper] to a fee tier's tick spacing and the usable V3 bounds:
 *   - lower rounds DOWN, upper rounds UP to multiples of `spacing` (never narrows the user's band);
 *   - both clamp into [minUsableTick, maxUsableTick] (±887220 for spacing 60);
 *   - guarantees tickLower < tickUpper - if rounding/clamping collapses them, widens by ONE spacing
 *     (upward when room allows, else downward at the top bound).
 * Reversed inputs are swapped defensively. Already-aligned in-bounds ranges pass through untouched.
 */
export function alignTicks(tickLower: number, tickUpper: number, spacing: number): TickRange {
  assertSpacing(spacing);
  let rawLo = tickLower;
  let rawHi = tickUpper;
  if (rawLo > rawHi) [rawLo, rawHi] = [rawHi, rawLo];

  const max = maxUsableTick(spacing);
  const min = -max;
  // Math.floor/ceil (NOT trunc) so negative ticks round outward correctly: floor(−64580/60)·60 = −64620.
  let lo = Math.floor(rawLo / spacing) * spacing;
  let hi = Math.ceil(rawHi / spacing) * spacing;
  lo = Math.min(max, Math.max(min, lo));
  hi = Math.min(max, Math.max(min, hi));

  if (lo >= hi) {
    // Collapsed (equal inputs, or both clamped onto the same bound) - widen by exactly one spacing.
    if (lo + spacing <= max) hi = lo + spacing;
    else lo = hi - spacing; // pinned at the top bound: the only legal widening is downward
  }
  return { tickLower: lo, tickUpper: hi };
}

/** Range preset ids surfaced by the UI. Percentages are HUMAN-price band half-widths (see presetTicks). */
export type RangePreset = 'narrow' | 'balanced' | 'wide' | 'full';

/**
 * Band half-width per preset, as a fraction (narrow ±5%, balanced ±15%, wide ±50%). Exported so the
 * UI can label the buttons from the same source of truth. 'full' has no percentage (whole tick domain).
 * NOTE for labels: presetTicks applies these SYMMETRICALLY IN LOG SPACE (×(1+x) up, ÷(1+x) down),
 * not arithmetic ±x% - a "±5%" label is approximate (the down-side is −1+1/1.05 ≈ −4.76%).
 */
export const PRESET_PCT: Readonly<Record<Exclude<RangePreset, 'full'>, number>> = Object.freeze({
  narrow: 0.05,
  balanced: 0.15,
  wide: 0.5,
});

/**
 * Build a preset range around the CURRENT tick. The ±x% band is SYMMETRIC IN LOG SPACE: the tick
 * delta is round(ln(1+x)/ln(1.0001)) (≈ ±488 ticks for 5%, ±1398 for 15%, ±4055 for 50%), applied
 * both sides of currentTick, then spacing-aligned outward. Because ticks live in raw-price log space
 * and the human price is the reciprocal when baseIsToken0=false, a ±x% band in raw space is the
 * SAME band as ∓x% in human space - log symmetry makes the result orientation-independent, so this
 * function needs no decimals/orientation inputs at all. 'full' = the whole usable range
 * [−maxUsableTick, +maxUsableTick]. The returned range contains currentTick (in-range) whenever
 * |currentTick| ≤ maxUsableTick(spacing) - true for any live pool tick in practice; a tick beyond
 * the usable bounds clamps to the boundary band, which cannot contain it.
 */
export function presetTicks(preset: RangePreset, currentTick: number, spacing: number): TickRange {
  assertSpacing(spacing);
  if (preset === 'full') {
    const max = maxUsableTick(spacing);
    return { tickLower: -max, tickUpper: max };
  }
  const pct = PRESET_PCT[preset];
  if (pct === undefined) throw new Error(`[rangeMath] unknown preset "${String(preset)}"`);
  const delta = Math.round(Math.log(1 + pct) / LOG_1_0001);
  return alignTicks(currentTick - delta, currentTick + delta, spacing);
}

/**
 * Custom range from user-entered HUMAN prices (quote per base, e.g. USDC per cirBTC):
 * 0 < minPrice < maxPrice (throws otherwise - the UI validates before calling). Each price maps to
 * its nearest tick, then the PAIR is ordered numerically - this is where the inversion is resolved:
 * with baseIsToken0=false the HIGHER human price (maxPrice) becomes tickLower and minPrice becomes
 * tickUpper; with baseIsToken0=true the order is preserved. Result is spacing-aligned via alignTicks.
 */
export function customTicks(
  minPrice: number,
  maxPrice: number,
  dec0: number,
  dec1: number,
  baseIsToken0: boolean,
  spacing: number,
): TickRange {
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice <= 0 || minPrice >= maxPrice) {
    throw new Error(`[rangeMath] need 0 < minPrice < maxPrice, got [${minPrice}, ${maxPrice}]`);
  }
  const tickA = priceToTick(minPrice, dec0, dec1, baseIsToken0);
  const tickB = priceToTick(maxPrice, dec0, dec1, baseIsToken0);
  return alignTicks(Math.min(tickA, tickB), Math.max(tickA, tickB), spacing);
}

// ── sqrtRatioAtTick - canonical Uniswap TickMath.getSqrtRatioAtTick, bigint port ────────────────

// Per-bit Q128.128 multipliers for sqrt(1.0001^−bit), copied verbatim from lib/v3-core
// TickMath.sol. The 0x1 bit is the seed (handled inline); each table entry is [bit, factor].
const TICK_FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/**
 * sqrt(1.0001^tick)·2^96 as a bigint - the EXACT on-chain TickMath.getSqrtRatioAtTick value (same
 * bit-decomposition algorithm and constants, same round-up from Q128.128 to Q64.96), so counterpart
 * amounts computed here match what the pool/NPM will compute at mint time. Monotonic in tick;
 * round-trips with tickToPrice/priceToTick (validated in tests against MIN/MAX_SQRT_RATIO and the
 * live pool's slot0). Throws if tick is not an integer in [MIN_TICK, MAX_TICK].
 */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`[rangeMath] tick must be an integer in [${MIN_TICK}, ${MAX_TICK}], got ${tick}`);
  }
  const absTick = tick < 0 ? -tick : tick;
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, factor] of TICK_FACTORS) {
    if ((absTick & bit) !== 0) ratio = (ratio * factor) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 → Q64.96, rounding UP (exactly as TickMath does) so tick→sqrt→tick stays consistent.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// ── Counterpart-amount math (bigint-exact LiquidityAmounts relations) ────────────────────────────

/** Where the current tick sits relative to a position's range (drives the risk badges). */
export type RangeStatus = 'in-range' | 'below' | 'above';

/**
 * Classify the CURRENT tick against [tickLower, tickUpper) using the V3 fee-earning convention
 * (in-range iff tickLower ≤ currentTick < tickUpper). 'below'/'above' are in RAW tick space
 * (token1-per-token0): with baseIsToken0=false, 'below' means the HUMAN price is ABOVE the band
 * (inversion) - the UI should phrase badges as in-range vs out-of-range, or re-map the direction.
 * Out of range = the position earns NO fees and contributes NOTHING to the arena (in-range gated).
 * BOUNDARY NOTE: this classifies by TICK while counterpartAmount's one-sided test is by sqrtPRICE -
 * when slot0's sqrtPriceX96 EXACTLY equals sqrtRatioAtTick(tickLower) this says 'in-range' but
 * counterpartAmount returns 0n (see its doc; the position genuinely needs zero token1 there).
 */
export function tickRangeStatus(currentTick: number, tickLower: number, tickUpper: number): RangeStatus {
  if (currentTick < tickLower) return 'below';
  if (currentTick >= tickUpper) return 'above';
  return 'in-range';
}

export interface CounterpartAmountArgs {
  /** The amount the user TYPED, raw units of the token identified by inputIsToken0. */
  amountIn: bigint;
  /** true = amountIn is token0 (counterpart returned is token1); false = the reverse. */
  inputIsToken0: boolean;
  /** Current pool sqrtPriceX96 (slot0[0]). */
  sqrtPriceX96: bigint;
  /** sqrtRatioAtTick(tickLower) - lower bound of the range. */
  sqrtLowerX96: bigint;
  /** sqrtRatioAtTick(tickUpper) - upper bound of the range. */
  sqrtUpperX96: bigint;
}

/**
 * Given ONE side of a V3 mint, compute the OTHER side (bigint, floor-rounded, never negative) -
 * the "one input drives the other" core. Canonical LiquidityAmounts relations, full-precision
 * single floor-division per step:
 *
 *   in range (sqrtL < sqrtP < sqrtU):
 *     from token0: L = amount0·sqrtP·sqrtU / (Q96·(sqrtU−sqrtP));  amount1 = L·(sqrtP−sqrtL)/Q96
 *     from token1: L = amount1·Q96/(sqrtP−sqrtL);                  amount0 = L·Q96·(sqrtU−sqrtP)/(sqrtP·sqrtU)
 *
 *   price below range (sqrtP ≤ sqrtL): the position is ALL token0 → counterpart is EXACTLY 0n
 *   price above range (sqrtP ≥ sqrtU): the position is ALL token1 → counterpart is EXACTLY 0n
 *
 * A 0n result for an out-of-range band is REQUIRED behaviour (one-sided mint), not an error. Note
 * it is returned for BOTH input directions when out of range: if the INPUT token is the inactive
 * side (e.g. token1 input while the price is below the range) the input itself is unusable - the
 * caller should check tickRangeStatus() and drive the form from the active side only.
 * Degenerate inputs (amountIn ≤ 0, non-positive sqrtP, sqrtLower ≥ sqrtUpper) return 0n.
 *
 * BOUNDARY NOTE: the one-sided test here is by sqrtPRICE (sqrtP ≤ sqrtL / sqrtP ≥ sqrtU) while
 * tickRangeStatus classifies by TICK - when sqrtP EXACTLY equals sqrtRatioAtTick(tickLower) the
 * tick equals tickLower so tickRangeStatus says 'in-range', yet this returns 0n. That 0n is the
 * correct mint amount (at sqrtP == sqrtL the position holds zero token1), so a caller gating a
 * two-sided mint on both legs > 0 simply stays disabled at that measure-zero boundary - the two
 * conventions never produce WRONG amounts, only a conservative disable.
 */
export function counterpartAmount({
  amountIn,
  inputIsToken0,
  sqrtPriceX96,
  sqrtLowerX96,
  sqrtUpperX96,
}: CounterpartAmountArgs): bigint {
  if (amountIn <= 0n || sqrtPriceX96 <= 0n || sqrtLowerX96 <= 0n || sqrtUpperX96 <= sqrtLowerX96) return 0n;

  // One-sided regimes: the counterpart side of the mint is exactly zero (see doc above).
  if (sqrtPriceX96 <= sqrtLowerX96 || sqrtPriceX96 >= sqrtUpperX96) return 0n;

  let out: bigint;
  if (inputIsToken0) {
    // L from the token0 leg (only the [sqrtP, sqrtU] segment holds token0)…
    const liquidity = (amountIn * sqrtPriceX96 * sqrtUpperX96) / (Q96 * (sqrtUpperX96 - sqrtPriceX96));
    // …then the token1 leg from L over [sqrtL, sqrtP].
    out = (liquidity * (sqrtPriceX96 - sqrtLowerX96)) / Q96;
  } else {
    // L from the token1 leg (only the [sqrtL, sqrtP] segment holds token1)…
    const liquidity = (amountIn * Q96) / (sqrtPriceX96 - sqrtLowerX96);
    // …then the token0 leg from L over [sqrtP, sqrtU]. NOTE: this branch floors TWICE (L, then
    // amount0), so it can UNDERESTIMATE the token0 counterpart by up to ~Q96/sqrtP raw units
    // (≈25 raw = 0.000025 USDC at the live ~63.7k price, where sqrtP < Q96). That is the SAFE
    // direction - the mint pulls slightly less, never more - and mirrors the on-chain two-step
    // LiquidityAmounts computation (getLiquidityForAmount1 → getAmount0ForLiquidity).
    out = (liquidity * Q96 * (sqrtUpperX96 - sqrtPriceX96)) / (sqrtPriceX96 * sqrtUpperX96);
  }
  return out < 0n ? 0n : out; // floor-division can round to 0n but must never surface a negative
}
