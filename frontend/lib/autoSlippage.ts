// lib/autoSlippage.ts — how wide the swap's `amountOutMinimum` floor should be.
//
// The number has one job: absorb the difference between the quote the user saw and what the pool
// actually pays at execution. Two things create that difference.
//
//   1. The pool moves between quote and signature. Bounded by time, not by trade size.
//   2. The quote itself may be wrong. An exact quote (QuoterV2 walks the ticks) has no such error;
//      the local constant-liquidity estimate does, and it grows with how far the trade pushes the
//      price, because that is when it crosses into liquidity it never modelled.
//
// Measured while the cirBTC/USDC pool sat off its peg: the local estimate was 6.6% high on a trade it
// called 0.04% impact. So the estimate's error does NOT track impact reliably, which is why the
// fallback floor is wide and flat rather than clever. When the quote is exact, a small buffer is
// genuinely enough and the user keeps the protection a tight bound gives them.

/** Never floor a trade tighter than this; below it, ordinary block-to-block movement reverts. */
export const MIN_AUTO_BPS = 50;
/** Auto never exceeds this on its own. Beyond it the user has to type a number and mean it. */
export const MAX_AUTO_BPS = 1_500;

export interface AutoSlippageInput {
  /** Price impact of the trade, in basis points. */
  priceImpactBps: number;
  /** True when the quote came from the on-chain quoter rather than the local estimate. */
  exact: boolean;
}

/**
 * Auto slippage in basis points.
 *
 * Exact quote: a floor plus a quarter of the impact. Impact is the pool moving under the trade, and
 * a fraction of it covers the drift between quote and execution.
 *
 * Estimated quote: a much wider floor, because the estimate's own error is the dominant term and it
 * is not predictable from impact. This is the case that used to produce "Too little received".
 */
export function autoSlippageBps({ priceImpactBps, exact }: AutoSlippageInput): number {
  const impact = Number.isFinite(priceImpactBps) && priceImpactBps > 0 ? priceImpactBps : 0;
  const floor = exact ? MIN_AUTO_BPS : 300;
  const buffer = exact ? Math.ceil(impact / 4) : Math.ceil(impact / 2);
  return Math.min(MAX_AUTO_BPS, Math.max(MIN_AUTO_BPS, floor + buffer));
}
