'use client';

// hooks/usePriceSamples.ts — the live "pulse" feed for the Arena price chart. A fixed-interval (1s)
// ring buffer of the oracle price, built for a FLUID always-moving chart (the user's reference is
// xo.market's pulse ticker):
//   • INSTANT render: the very first oracle read seeds the whole buffer flat at that price, so the
//     chart appears immediately (no "collecting…" wait for N distinct reads).
//   • 1s tick: every second a new point is appended and the window slides — the line always moves.
//   • EASING: the on-chain oracle refreshes ~every 5s in steps; each tick moves the plotted value a
//     fraction toward the latest read, so steps render as smooth glides instead of jumps. Display
//     only — every value converges to genuine oracle reads, nothing is invented beyond interpolation.
import { useEffect, useRef, useState } from 'react';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { useActiveMarket } from '@/components/MarketProvider';
import { formatPrice18 } from '@/lib/format';

export function usePriceSamples(max = 90): number[] {
  const { data } = useOraclePrice();
  // Each market's oracle chart is INDEPENDENT. Without keying on the active market, switching tabs
  // would ease the existing buffer (the old market's prices, e.g. cirBTC/USDC ~$63k) toward the new
  // market's price (cirBTC/EURC ~€55k) — rendering a phantom rise/drop between unrelated markets.
  const marketId = useActiveMarket().id;
  const [samples, setSamples] = useState<number[]>([]);
  const targetRef = useRef<number | undefined>(undefined);

  // Reset on a market switch so the chart re-seeds flat at the NEW market's first read with no
  // carry-over from the previous market (the seed effect below re-fills once this market's price loads).
  useEffect(() => {
    targetRef.current = undefined;
    setSamples([]);
  }, [marketId]);

  // Track the latest genuine oracle read; seed the buffer flat on the FIRST one.
  useEffect(() => {
    if (!data || data.price18 === 0n) return;
    const px = Number(formatPrice18(data.price18));
    if (!Number.isFinite(px) || px <= 0) return;
    targetRef.current = px;
    setSamples((prev) => (prev.length === 0 ? Array<number>(max).fill(px) : prev));
  }, [data, max]);

  // The 1s pulse: append an eased step toward the live target, slide the window.
  useEffect(() => {
    const id = setInterval(() => {
      const target = targetRef.current;
      if (target === undefined) return;
      setSamples((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        const next = last + (target - last) * 0.35;
        const out = prev.length >= max ? [...prev.slice(1), next] : [...prev, next];
        return out;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [max]);

  return samples;
}
