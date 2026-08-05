// poolMath.ts - PURE Uniswap-V3 price math for the arb bot. Converts a pool's
// sqrtPriceX96 (token1-per-token0 in Q64.96, raw-unit terms) into the human
// USDC-per-base price in 18dp (poolPrice18) that decideArb compares against the Pyth
// reference, and converts a target USDC-per-base price back into a sqrtPriceX96 limit
// the executor pins on exactInputSingle so the AMM can never push the pool past the
// oracle. No I/O, no chain reads - every input is supplied, so it is fully unit-testable.
//
// Conventions:
//   - token0/token1 are the pool's ADDRESS-SORTED pair. The base token (e.g. cirBTC, 8dp)
//     may be token0 OR token1 depending on address sort vs USDC (6dp), so the caller passes
//     `baseIsToken0`.
//   - Uniswap price P = (sqrtPriceX96 / 2^96)^2 = token1_raw per 1 token0_raw.
//   - We want USDC-per-base in 18dp: 1 whole base (10^baseDec raw) -> how many whole USDC
//     (10^quoteDec raw), expressed * 10^18.

const Q96 = 1n << 96n;
const ONE18 = 10n ** 18n;

/**
 * Integer square root (floor) for bigint. Newton's method; total for x >= 0.
 */
export function isqrt(x: bigint): bigint {
  if (x < 0n) throw new Error('isqrt of negative');
  if (x < 2n) return x;
  let lo = 1n;
  let hi = x;
  // Binary search for floor(sqrt(x)) - robust and overflow-free for bigint.
  while (lo < hi) {
    const mid = (lo + hi + 1n) >> 1n;
    if (mid * mid <= x) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * Convert a pool sqrtPriceX96 into USDC-per-base in 18dp.
 *
 * Let P_raw = (sqrtPriceX96^2) / 2^192 = token1_raw per token0_raw.
 * If base is token0: USDC(=token1) per base(=token0) in raw terms is P_raw. Convert raw
 *   ratio to whole-token ratio: price_whole = P_raw * 10^baseDec / 10^quoteDec, then *1e18.
 * If base is token1: invert -> raw base per raw USDC is P_raw, so USDC per base raw is
 *   1/P_raw; price_whole = (1/P_raw) * 10^baseDec / 10^quoteDec.
 *
 * We compute with full bigint precision (numerator scaled by 1e18) and floor-divide.
 */
export function sqrtPriceX96ToPrice18(
  sqrtPriceX96: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  baseIsToken0: boolean,
): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const sp2 = sqrtPriceX96 * sqrtPriceX96; // token1/token0 * 2^192
  const baseScale = 10n ** BigInt(baseDecimals);
  const quoteScale = 10n ** BigInt(quoteDecimals);

  if (baseIsToken0) {
    // price18 = (sp2 / 2^192) * (baseScale/quoteScale) * 1e18
    //         = sp2 * baseScale * 1e18 / (2^192 * quoteScale)
    return (sp2 * baseScale * ONE18) / (Q96 * Q96 * quoteScale);
  }
  // base is token1: USDC(token0) per base(token1) raw = 2^192 / sp2.
  // price18 = (2^192 / sp2) * (baseScale/quoteScale) * 1e18
  //         = 2^192 * baseScale * 1e18 / (sp2 * quoteScale)
  return (Q96 * Q96 * baseScale * ONE18) / (sp2 * quoteScale);
}

/**
 * Convert a target USDC-per-base price (18dp) into the sqrtPriceX96 that the pool would
 * have AT that price. Inverse of sqrtPriceX96ToPrice18. Used to pin sqrtPriceLimitX96 on
 * exactInputSingle to the ref tick so the swap can never move the pool past the oracle.
 *
 * From the forward formulas:
 *   baseIsToken0:  sp2 = price18 * Q96^2 * quoteScale / (baseScale * 1e18)
 *   base==token1:  sp2 = Q96^2 * baseScale * 1e18 / (price18 * quoteScale)
 * then sqrtPriceX96 = floor(sqrt(sp2)).
 */
export function price18ToSqrtPriceX96(
  price18: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  baseIsToken0: boolean,
): bigint {
  if (price18 <= 0n) return 0n;
  const baseScale = 10n ** BigInt(baseDecimals);
  const quoteScale = 10n ** BigInt(quoteDecimals);

  let sp2: bigint;
  if (baseIsToken0) {
    sp2 = (price18 * Q96 * Q96 * quoteScale) / (baseScale * ONE18);
  } else {
    sp2 = (Q96 * Q96 * baseScale * ONE18) / (price18 * quoteScale);
  }
  return isqrt(sp2);
}

/**
 * Δamount0 - the token0 amount that moves a single-tick V3 position between two
 * sqrt-prices, given constant active liquidity L. Canonical Uniswap-V3 formula:
 *
 *   amount0 = L * 2^96 * (sqrtB - sqrtA) / (sqrtA * sqrtB)
 *
 * Order-independent: |sqrtB - sqrtA| is used so the magnitude is returned regardless of
 * direction. Returns 0 if either sqrt-price is non-positive (defensive). PURE.
 */
export function amount0Delta(liquidity: bigint, sqrtA: bigint, sqrtB: bigint): bigint {
  if (liquidity <= 0n || sqrtA <= 0n || sqrtB <= 0n) return 0n;
  let lo = sqrtA;
  let hi = sqrtB;
  if (lo > hi) [lo, hi] = [hi, lo];
  return (liquidity * Q96 * (hi - lo)) / (lo * hi);
}

/**
 * Δamount1 - the token1 amount that moves a single-tick V3 position between two
 * sqrt-prices, given constant active liquidity L:
 *
 *   amount1 = L * (sqrtB - sqrtA) / 2^96
 *
 * Order-independent magnitude. Returns 0 if liquidity is non-positive. PURE.
 */
export function amount1Delta(liquidity: bigint, sqrtA: bigint, sqrtB: bigint): bigint {
  if (liquidity <= 0n) return 0n;
  let lo = sqrtA;
  let hi = sqrtB;
  if (lo > hi) [lo, hi] = [hi, lo];
  return (liquidity * (hi - lo)) / Q96;
}

/**
 * The BASE-token amount (raw, at baseDecimals) that moves the pool price from
 * `fromPrice18` to `toPrice18` (both USDC-per-base, 18dp) given the live in-range
 * liquidity L. This is the root-cause sizing primitive for the arb bot: it derives the
 * trade size from the pool's OWN depth via the V3 sqrt-price relationship instead of
 * anchoring to a divergence-scaled fraction of maxTradeBase (which produced a dead-zone
 * around the arena band - see decideArb's HIGH-1 fix).
 *
 * Token orientation matters: the BASE token is token0 of the pool when baseIsToken0, else
 * token1. We compute the delta of whichever pool token IS the base:
 *   - base==token0  -> amount0Delta (e.g. an inverted-sort market)
 *   - base==token1  -> amount1Delta (the cirBTC/USDC case: token0=USDC, token1=cirBTC)
 *
 * The result is the base amount the swap consumes/produces on the base leg, which is
 * exactly `amountInBase` for a SELL_BASE and the base TARGET for a BUY_BASE (the executor
 * converts that target into the USDC to spend at the ref price). Returns 0 when the two
 * prices are equal (zero-width move) or liquidity is non-positive. PURE - no chain reads.
 */
export function baseAmountToMovePrice(
  liquidity: bigint,
  fromPrice18: bigint,
  toPrice18: bigint,
  baseDecimals: number,
  quoteDecimals: number,
  baseIsToken0: boolean,
): bigint {
  if (liquidity <= 0n || fromPrice18 <= 0n || toPrice18 <= 0n) return 0n;
  const sqrtFrom = price18ToSqrtPriceX96(fromPrice18, baseDecimals, quoteDecimals, baseIsToken0);
  const sqrtTo = price18ToSqrtPriceX96(toPrice18, baseDecimals, quoteDecimals, baseIsToken0);
  return baseIsToken0
    ? amount0Delta(liquidity, sqrtFrom, sqrtTo)
    : amount1Delta(liquidity, sqrtFrom, sqrtTo);
}

// ─── DELIVERABILITY caps - size a leg to what the pool can PHYSICALLY pay ───────────────────────
// The constant-L sizing above (baseAmountToMovePrice) UNDER-counts across a tick crossing: it
// assumes liquidity stays in range, so at the range edge it can size a SELL the pool can't actually
// pay - the swap then fills far below its ref-priced amountOutMinimum and reverts "Too little
// received" (the exact one-sided-pool wedge that drained the keepers). The pool's RAW token
// balanceOf is the true hard ceiling on what a single swap can extract, and it's one cheap view
// call (the repo has no on-chain Quoter). We cap every leg at a safety fraction of that real
// balance so the realized fill - which moves price against us as it consumes the reserve - still
// clears the ref-priced min-out. Belt-and-suspenders: callers take min(pegMoveSize, deliverableCap).

/**
 * The USDC a SELL_BASE can safely extract from the pool: a safety fraction (safetyBps) of the
 * pool's real USDC balance. On a one-sided (USDC-empty) pool this is ~0, which collapses the SELL
 * size to dust → the caller idles instead of firing a doomed swap. PURE.
 */
export function poolDeliverableQuote(poolQuoteBal: bigint, safetyBps: number): bigint {
  if (poolQuoteBal <= 0n || safetyBps <= 0) return 0n;
  return (poolQuoteBal * BigInt(safetyBps)) / 10_000n;
}

/**
 * The cirBTC a BUY_BASE can safely take out of the pool: a safety fraction of the pool's real base
 * balance. The direct cap on a BUY's base output (a BUY can never extract more base than the pool
 * holds). PURE.
 */
export function poolDeliverableBase(poolBaseBal: bigint, safetyBps: number): bigint {
  if (poolBaseBal <= 0n || safetyBps <= 0) return 0n;
  return (poolBaseBal * BigInt(safetyBps)) / 10_000n;
}

/**
 * Convert a deliverable-USDC ceiling (raw at quoteDecimals) into the LARGEST base SELL whose
 * ref-priced proceeds fit under it - the inverse of usdcBudgetToBase:
 *   baseRaw = deliverableUsdcRaw * 1e18 * 10^baseDec / (ref18 * 10^quoteDec)
 * So a SELL sized at this (or less) asks the pool for at most `deliverableQuoteRaw` USDC, which the
 * pool can pay. Decimals-generic (cirBTC 8dp / USDC 6dp). PURE.
 */
export function maxBaseSellForUsdcOut(
  deliverableQuoteRaw: bigint,
  ref18: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  if (ref18 <= 0n || deliverableQuoteRaw <= 0n) return 0n;
  const baseScale = 10n ** BigInt(baseDecimals);
  const quoteScale = 10n ** BigInt(quoteDecimals);
  return (deliverableQuoteRaw * ONE18 * baseScale) / (ref18 * quoteScale);
}
