'use client';

// hooks/useExactQuote.ts — the swap form's quote, from the pool itself.
//
// The form used to price a trade from (sqrtPriceX96, liquidity) alone, which assumes active
// liquidity stays constant for the whole swap. True while the pool was one full-range position;
// false once LPs could mint narrow ranges. A trade that crosses into a thinner tick receives less
// than that formula predicts, the form floored `amountOutMinimum` off the optimistic number, and
// the pool refused to fill: "Too little received" on a swap the user could afford. On the live
// cirBTC/USDC pool the gap reached 6.6% on a trade the form called 0.04% impact.
//
// QuoterV2 walks the ticks exactly as the pool would. It is a read-only lens that reverts internally
// and decodes its own revert payload, so the call needs neither balance nor allowance and works for
// a visitor who has never touched the token.
//
// The local estimate stays as a fallback for the moments the quoter cannot answer (a market with no
// quoter configured, an RPC hiccup). It is reported as inexact so slippage can widen to match.
import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { quoterV2Abi } from '@/abis';
import { ARC_CHAIN_ID } from '@/lib/chain';
import { ENV } from '@/lib/env';

export interface ExactQuote {
  amountOut: bigint;
  priceImpactBps: number;
  /** True when this came from the quoter; false when it is the local constant-liquidity estimate. */
  exact: boolean;
  /** How many initialized ticks the trade crosses. Above zero the local estimate would be wrong. */
  ticksCrossed: number;
  loading: boolean;
}

/** Spot price from sqrtPriceX96, as a ratio scaled by 1e18, for an impact comparison. */
function priceX18(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (2n ** 192n);
}

/** Impact is capped at 100%. A trade that drains the pool sends the raw ratio to absurdity
 *  (1,106,799,969,137.93% appeared on screen); past "the whole pool" the exact figure tells the
 *  user nothing they cannot already see, and a readable number keeps the warning credible. */
const MAX_IMPACT_BPS = 10_000;

function impactBps(before: bigint, after: bigint): number {
  if (before <= 0n || after <= 0n) return 0;
  const diff = after > before ? after - before : before - after;
  const bps = (diff * 10_000n) / before;
  return Number(bps > BigInt(MAX_IMPACT_BPS) ? BigInt(MAX_IMPACT_BPS) : bps);
}

/**
 * Quote `amountIn` of `tokenIn` for `tokenOut`, exactly when possible.
 *
 * `fallback` is the local estimate the caller already computed; it is returned unchanged while the
 * quoter is in flight and whenever the quoter cannot answer, so the form never blanks out.
 */
export function useExactQuote(args: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  feeTier: number | undefined;
  sqrtPriceX96: bigint;
  fallback: { amountOut: bigint; priceImpactBps: number };
}): ExactQuote {
  const { tokenIn, tokenOut, amountIn, feeTier, sqrtPriceX96, fallback } = args;
  const client = usePublicClient({ chainId: ARC_CHAIN_ID });
  const quoter = ENV.QUOTER_ADDRESS;

  const [state, setState] = useState<{ amountOut: bigint; impact: number; ticks: number } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!client || !quoter || !feeTier || amountIn <= 0n) {
      setState(null);
      return;
    }
    let cancelled = false;
    setLoading(true);

    void client
      .simulateContract({
        address: quoter,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn, fee: feeTier, sqrtPriceLimitX96: 0n }],
      })
      .then((res) => {
        if (cancelled) return;
        const [amountOut, sqrtAfter, ticks] = res.result as readonly [bigint, bigint, number, bigint];
        setState({
          amountOut,
          impact: impactBps(priceX18(sqrtPriceX96), priceX18(sqrtAfter)),
          ticks: Number(ticks),
        });
      })
      .catch(() => {
        // A pool with no liquidity at all reverts here. Falling back keeps the form readable, and
        // `exact: false` is what widens the slippage floor to match the weaker number.
        if (!cancelled) setState(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, quoter, tokenIn, tokenOut, amountIn, feeTier, sqrtPriceX96]);

  if (state) {
    return { amountOut: state.amountOut, priceImpactBps: state.impact, exact: true, ticksCrossed: state.ticks, loading };
  }
  return { amountOut: fallback.amountOut, priceImpactBps: fallback.priceImpactBps, exact: false, ticksCrossed: 0, loading };
}
