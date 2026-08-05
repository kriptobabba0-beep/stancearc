// lib/agent/lpPlan.ts - size a to-be-minted LP position from a TOTAL value + optional price band.
//
// The copilot's add_liquidity card asks for "$V across [lower, upper]"; this turns that into the
// exact (base, quote) legs the pool will pull at the live price. Pure math over lib/rangeMath's
// canonical primitives so the split is unit-testable without a chain: in-band positions scale a
// quote-side probe (the split is linear), out-of-band positions are legitimately one-sided.
import { parseUnits, formatUnits } from 'viem';
import { customTicks, sqrtRatioAtTick, sqrtPriceX96ToPrice, counterpartAmount } from '@/lib/rangeMath';
import { fullRangeTicks, tickSpacingForFee } from '@/hooks/useMintPosition';

export interface LpPlanArgs {
  /** Total position value in quote terms (e.g. 5 = $5 across both legs). */
  amountUsdc: number;
  /** Optional HUMAN price band (quote per base). Both set, or neither (= full range). */
  priceLower?: number;
  priceUpper?: number;
  /** The pool's live sqrt price (slot0). */
  sqrtPriceX96: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  baseIsToken0: boolean;
  feeTier: number;
}

export interface LpPlanResult {
  tickLower: number;
  tickUpper: number;
  /** Base-token leg, raw units at baseDecimals. */
  baseLeg: bigint;
  /** Quote-token leg, raw units at quoteDecimals. */
  usdcLeg: bigint;
  /** Live human price (quote per base) the split was computed at. */
  priceNow: number;
  /** True when the live price sits outside the band - the position starts one-sided. */
  outOfBand: boolean;
}

/**
 * Token amounts a position of `liquidity` holds at the live price - the canonical
 * LiquidityAmounts.getAmountsForLiquidity split. Used to tell the user what an LP NFT
 * actually CONTAINS (the sweep-back note listed only loose balances, so a $100 position
 * read as "$2 returned").
 */
export function positionAmounts(a: {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
}): { amount0: bigint; amount1: bigint } {
  if (a.liquidity <= 0n || a.sqrtPriceX96 <= 0n) return { amount0: 0n, amount1: 0n };
  const Q96 = 2n ** 96n;
  const sqrtL = sqrtRatioAtTick(a.tickLower);
  const sqrtU = sqrtRatioAtTick(a.tickUpper);
  if (sqrtU <= sqrtL) return { amount0: 0n, amount1: 0n };
  const sp = a.sqrtPriceX96;
  if (sp <= sqrtL) return { amount0: (a.liquidity * Q96 * (sqrtU - sqrtL)) / (sqrtL * sqrtU), amount1: 0n };
  if (sp >= sqrtU) return { amount0: 0n, amount1: (a.liquidity * (sqrtU - sqrtL)) / Q96 };
  return {
    amount0: (a.liquidity * Q96 * (sqrtU - sp)) / (sp * sqrtU),
    amount1: (a.liquidity * (sp - sqrtL)) / Q96,
  };
}

export function planLiquidity(a: LpPlanArgs): LpPlanResult {
  const dec0 = a.baseIsToken0 ? a.baseDecimals : a.quoteDecimals;
  const dec1 = a.baseIsToken0 ? a.quoteDecimals : a.baseDecimals;
  const { tickLower, tickUpper } =
    a.priceLower !== undefined && a.priceUpper !== undefined
      ? customTicks(a.priceLower, a.priceUpper, dec0, dec1, a.baseIsToken0, tickSpacingForFee(a.feeTier))
      : fullRangeTicks(a.feeTier);
  const sqrtL = sqrtRatioAtTick(tickLower);
  const sqrtU = sqrtRatioAtTick(tickUpper);
  const priceNow = sqrtPriceX96ToPrice(a.sqrtPriceX96, dec0, dec1, a.baseIsToken0);
  if (priceNow <= 0) throw new Error('pool price unavailable');
  if (!Number.isFinite(a.amountUsdc) || a.amountUsdc <= 0) throw new Error('amount must be positive');
  // parseUnits throws on more fractional digits than the token carries (e.g. "5.12345678901"
  // for 6dp USDC) - clamp the ASK to the quote token's own precision first.
  const amountStr = a.amountUsdc.toFixed(a.quoteDecimals);

  const usdcIsToken0 = !a.baseIsToken0;
  const allToken0 = a.sqrtPriceX96 <= sqrtL;
  const allToken1 = a.sqrtPriceX96 >= sqrtU;
  let usdcLeg = 0n;
  let baseLeg = 0n;
  if (allToken0 || allToken1) {
    // One-sided: the whole value sits in whichever token the range holds at this price.
    const baseSide = (allToken0 && a.baseIsToken0) || (allToken1 && !a.baseIsToken0);
    if (baseSide) baseLeg = BigInt(Math.floor((a.amountUsdc / priceNow) * 10 ** a.baseDecimals));
    else usdcLeg = parseUnits(amountStr, a.quoteDecimals);
  } else {
    const probe = parseUnits(amountStr, a.quoteDecimals);
    const baseForProbe = counterpartAmount({
      amountIn: probe,
      inputIsToken0: usdcIsToken0,
      sqrtPriceX96: a.sqrtPriceX96,
      sqrtLowerX96: sqrtL,
      sqrtUpperX96: sqrtU,
    });
    const baseProbeUsd = Number(formatUnits(baseForProbe, a.baseDecimals)) * priceNow;
    const f = a.amountUsdc / (a.amountUsdc + baseProbeUsd);
    usdcLeg = BigInt(Math.floor(Number(probe) * f));
    baseLeg = counterpartAmount({
      amountIn: usdcLeg,
      inputIsToken0: usdcIsToken0,
      sqrtPriceX96: a.sqrtPriceX96,
      sqrtLowerX96: sqrtL,
      sqrtUpperX96: sqrtU,
    });
  }
  if (usdcLeg <= 0n && baseLeg <= 0n) throw new Error('amount too small for this range');
  return { tickLower, tickUpper, baseLeg, usdcLeg, priceNow, outOfBand: allToken0 || allToken1 };
}
