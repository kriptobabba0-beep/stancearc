'use client';

// hooks/usePythProvenance.ts - read the oracle PROVENANCE for the active market's Pyth feed via
// IPyth.getPriceUnsafe(feedId) -> (price, conf, expo, publishTime). Used by the provably-fair epoch
// detail page to surface WHO/WHAT priced the settlement: the immutable feed id (from market config)
// plus the latest on-chain publishTime + confidence interval. Best-effort; degrades gracefully.
import { useReadContract } from 'wagmi';
import { pythContract } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { arcTestnet } from '@/lib/chain';

export interface PythProvenance {
  /** Signed price as int64 (scale 10^expo). */
  price: bigint;
  /** Confidence interval (uint64), same scale as price. */
  conf: bigint;
  /** Price exponent (int32 → bigint), typically negative (e.g. -8). */
  expo: bigint;
  /** Unix seconds of the latest on-chain publish for this feed. */
  publishTime: bigint;
}

/** Latest on-chain Pyth price tuple for the active market's feed id, plus the feed id itself. */
export function usePythProvenance() {
  const market = useActiveMarket();
  const q = useReadContract({
    ...pythContract,
    functionName: 'getPriceUnsafe',
    args: [market.feedId],
    chainId: arcTestnet.id,
    query: { refetchInterval: 10_000 },
  });
  const tuple = q.data as readonly [bigint, bigint, bigint, bigint] | undefined;
  const provenance: PythProvenance | undefined = tuple
    ? { price: tuple[0], conf: tuple[1], expo: tuple[2], publishTime: tuple[3] }
    : undefined;
  return { ...q, feedId: market.feedId, data: provenance };
}
