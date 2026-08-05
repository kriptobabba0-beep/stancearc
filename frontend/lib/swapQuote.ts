// lib/swapQuote.ts - PURE, bigint exact-input single-pool swap quote for a FULL-RANGE Uniswap-V3-fork
// pool (the Arena pool is a single full-range position, so active liquidity L is CONSTANT and no tick
// is ever crossed). This lets the Swap form preview the output + price impact entirely client-side
// from the pool's live (sqrtPriceX96, liquidity) without a quoter contract.
//
// The formulas are the canonical Uniswap-V3 SqrtPriceMath exact-input relations, specialised to a
// single constant-L segment (ported from the same relations the keeper uses in keeper/src/poolMath.ts):
//
//   Q96 = 2^96. Fee is taken off the input first: amountInLessFee = amountIn·(1e6 − feePips)/1e6.
//
//   zeroForOne (token0 in → price falls):
//     sqrtNext = (L·sqrtP·Q96) / (L·Q96 + amountInLessFee·sqrtP)
//     amountOut(token1) = L·(sqrtP − sqrtNext) / Q96
//
//   !zeroForOne (token1 in → price rises):
//     sqrtNext = sqrtP + (amountInLessFee·Q96) / L
//     amountOut(token0) = (L·Q96·(sqrtNext − sqrtP)) / (sqrtP·sqrtNext)
//
// `priceImpactBps` is the relative move of the SPOT price P = (sqrtP/Q96)^2 in basis points:
//   priceImpactBps = 10000 · |P_after − P_before| / P_before = 10000 · |sqrtNext² − sqrtP²| / sqrtP².
// Computing it from the squares (not the formatted price) keeps it exact and direction-agnostic.
//
// All math is floor-division bigint (no Number, no rounding drift). Guards: L === 0 or amountIn === 0
// (or non-positive sqrtP) → a zero quote (amountOut 0, price unchanged, 0 impact), so the form can
// disable the button on an empty pool / empty input rather than dividing by zero.
//
// NOTE - concentrated (range-selectable) positions: now that LPs can mint NARROW ranges, the pool's
// active liquidity L is only piecewise-constant - a swap that pushes the price across a position's
// tick boundary changes L mid-swap, which this constant-L quote does not model. The quote is therefore
// an APPROXIMATION (slightly optimistic when crossing into thinner liquidity); the slippage-floored
// amountOutMinimum the form submits remains the actual execution guard - the swap reverts rather than
// fill past it. No logic change: the on-chain pool handles tick crossings exactly.

/** Q96 = 2^96 - the Uniswap fixed-point scale for sqrtPriceX96. */
export const Q96 = 2n ** 96n;

/** Fee denominator: feePips is in millionths (3000 = 0.3%). */
const FEE_DENOM = 1_000_000n;

export interface SwapQuote {
  /** Estimated output amount (raw units of the OUTPUT token: token1 when zeroForOne, else token0). */
  amountOut: bigint;
  /** The pool's sqrtPriceX96 AFTER this swap (constant-L move). Equals the input sqrtPriceX96 on a guard. */
  sqrtPriceAfterX96: bigint;
  /** Relative spot-price move in basis points (always ≥ 0). 0 on a guard / zero-size quote. */
  priceImpactBps: number;
}

export interface SwapQuoteArgs {
  /** Exact input amount (raw units of the input token). */
  amountIn: bigint;
  /** true = token0 in / token1 out (price falls); false = token1 in / token0 out (price rises). */
  zeroForOne: boolean;
  /** The pool's current sqrtPriceX96 (slot0). */
  sqrtPriceX96: bigint;
  /** The pool's current (full-range, constant) active liquidity L. */
  liquidity: bigint;
  /** Pool fee in pips (millionths), e.g. 3000 for 0.3%. */
  feePips: number;
}

/** Zero/identity quote used by every guard (empty pool, zero input, non-positive price). */
function zeroQuote(sqrtPriceX96: bigint): SwapQuote {
  return { amountOut: 0n, sqrtPriceAfterX96: sqrtPriceX96, priceImpactBps: 0 };
}

/**
 * Exact-input single-pool quote for a full-range (constant-L) Uniswap-V3 pool. PURE - every input is
 * supplied, no chain reads. Returns { amountOut, sqrtPriceAfterX96, priceImpactBps }.
 *
 * The output token is token1 when `zeroForOne` (token0 was the input) and token0 otherwise; the caller
 * maps that to the human token + decimals. amountOut floors down (you never quote more than the pool
 * gives), so a real swap with the same inputs returns ≥ the quote.
 */
export function quoteExactInputSingle({
  amountIn,
  zeroForOne,
  sqrtPriceX96,
  liquidity,
  feePips,
}: SwapQuoteArgs): SwapQuote {
  // Guards - an empty pool, empty input, or a degenerate price can't produce a meaningful quote.
  if (liquidity <= 0n || amountIn <= 0n || sqrtPriceX96 <= 0n) return zeroQuote(sqrtPriceX96);

  const fee = BigInt(feePips);
  // Fee is taken off the INPUT first (exactly as the V3 router does), then the net moves the price.
  const amountInLessFee = (amountIn * (FEE_DENOM - fee)) / FEE_DENOM;
  if (amountInLessFee <= 0n) return zeroQuote(sqrtPriceX96);

  let sqrtNext: bigint;
  let amountOut: bigint;

  if (zeroForOne) {
    // token0 in → price falls. sqrtNext = L·sqrtP·Q96 / (L·Q96 + amountInLessFee·sqrtP).
    const numerator = liquidity * sqrtPriceX96 * Q96;
    const denominator = liquidity * Q96 + amountInLessFee * sqrtPriceX96;
    sqrtNext = numerator / denominator;
    // The price can only fall here; clamp defensively so amountOut is never negative on rounding.
    if (sqrtNext > sqrtPriceX96) sqrtNext = sqrtPriceX96;
    // amountOut(token1) = L·(sqrtP − sqrtNext) / Q96.
    amountOut = (liquidity * (sqrtPriceX96 - sqrtNext)) / Q96;
  } else {
    // token1 in → price rises. sqrtNext = sqrtP + amountInLessFee·Q96 / L.
    sqrtNext = sqrtPriceX96 + (amountInLessFee * Q96) / liquidity;
    // amountOut(token0) = L·Q96·(sqrtNext − sqrtP) / (sqrtP·sqrtNext).
    amountOut = (liquidity * Q96 * (sqrtNext - sqrtPriceX96)) / (sqrtPriceX96 * sqrtNext);
  }

  return {
    amountOut: amountOut < 0n ? 0n : amountOut,
    sqrtPriceAfterX96: sqrtNext,
    priceImpactBps: priceImpactBps(sqrtPriceX96, sqrtNext),
  };
}

/**
 * Relative spot-price move in basis points between two sqrt-prices (constant L). PURE.
 * P = (sqrt/Q96)^2, so |ΔP|/P = |sqrtAfter² − sqrtBefore²| / sqrtBefore² - computed from the squares
 * for exactness. Always ≥ 0 (magnitude). Returns 0 when before is non-positive.
 */
export function priceImpactBps(sqrtBeforeX96: bigint, sqrtAfterX96: bigint): number {
  if (sqrtBeforeX96 <= 0n) return 0;
  const before2 = sqrtBeforeX96 * sqrtBeforeX96;
  const after2 = sqrtAfterX96 * sqrtAfterX96;
  const diff = after2 > before2 ? after2 - before2 : before2 - after2;
  // bps = 10000 · diff / before2, floor-divided in bigint then narrowed to a Number (always small).
  return Number((diff * 10_000n) / before2);
}
