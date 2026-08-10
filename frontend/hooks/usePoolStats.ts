'use client';

// hooks/usePoolStats.ts — REAL on-chain analytics for the Pool list page, in two independent queries so
// the page is snappy and degrades gracefully:
//
//   1. RESERVES (fast)  — multicall balanceOf(token0/token1)@pool + slot0 for every registry pool →
//                         per-token USD prices (each token priced off its own USDC pool; USDC≈1) and
//                         per-pool TVL. This is the headline number AND the list's sort key, so it must
//                         land first; it's a handful of reads.
//   2. FLOW (one fetch) — 24h volume (Σ swap notionals), fees (volume × fee tier), APR (annualised
//                         fees / TVL) and the header sparklines, read from /api/pool-stats. The
//                         event scan behind it runs on the server and is cached for the whole
//                         site, because Arc caps eth_getLogs at 10,000 blocks and doing it here
//                         cost every visitor about fifty round trips. It still fills in after the
//                         reserves, so the volume/fees/APR cells show a dash until it lands.
//
// Honest framing (see lib/poolStats): every figure restates real on-chain data — nothing fabricated.
import { useQuery } from '@tanstack/react-query';
import { getPublicClient } from 'wagmi/actions';
import { wagmiConfig } from '@/lib/wagmi';
import { arcTestnet } from '@/lib/chain';
import { POOLS } from '@/lib/pools';
import { derivePrices, readReserves, tvlForPool, type PoolFlow } from '@/lib/poolFlow';
import { feeAprPct, type UsdPriceMap } from '@/lib/poolStats';

export interface PoolStatRow {
  poolId: string;
  /** undefined while the reserves query is loading. */
  tvlUsd: number | undefined;
  /** undefined until the flow (event) query resolves. */
  volume24Usd: number | undefined;
  fees24Usd: number | undefined;
  aprPct: number | undefined;
}

export interface PoolStatsResult {
  rows: Record<string, PoolStatRow>;
  totals: { tvlUsd?: number; volume24Usd?: number; fees24Usd?: number };
  /** Aggregate sparkline series (oldest → newest) for the three header cards. */
  spark: { tvl: number[]; volume: number[]; fees: number[] };
  prices?: UsdPriceMap;
  isLoadingTvl: boolean;
  isLoadingFlow: boolean;
}

export function usePoolStats(): PoolStatsResult {
  // ── 1. Reserves + prices + TVL (fast) ──────────────────────────────────────────
  const reservesQuery = useQuery({
    queryKey: ['poolStats', 'reserves'],
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      const client = getPublicClient(wagmiConfig, { chainId: arcTestnet.id });
      if (!client) throw new Error('no rpc client');
      const { slot0ByPool, reserves } = await readReserves(client);
      const prices = derivePrices(slot0ByPool);
      const tvlByPool: Record<string, number | undefined> = {};
      for (const p of POOLS) tvlByPool[p.id] = tvlForPool(p.id, reserves[p.id], prices);
      return { prices, tvlByPool };
    },
  });

  // ── 2. 24h flow: volume / fees / APR / sparklines (one fetch) ──────────────
  // The scan behind this used to run here, which cost about fifty getLogs round trips per
  // visitor because Arc caps each one at 10,000 blocks. It now runs on the server and is
  // cached for everyone; see app/api/pool-stats/route.ts.
  const flowQuery = useQuery<PoolFlow>({
    queryKey: ['poolStats', 'flow'],
    refetchInterval: 60_000,
    staleTime: 45_000,
    queryFn: async () => {
      const res = await fetch('/api/pool-stats');
      if (!res.ok) throw new Error(`pool stats API ${res.status}`);
      return (await res.json()) as PoolFlow;
    },
  });

  // ── Merge ──────────────────────────────────────────────────────────────────────
  const rTvl = reservesQuery.data?.tvlByPool ?? {};
  const fFlow = flowQuery.data?.rowFlow ?? {};
  const prices = reservesQuery.data?.prices ?? flowQuery.data?.prices;

  const rows: Record<string, PoolStatRow> = {};
  let totalTvl: number | undefined;
  let totalVol: number | undefined;
  let totalFees: number | undefined;
  for (const p of POOLS) {
    const tvl = rTvl[p.id];
    const flow = fFlow[p.id];
    const apr = tvl !== undefined && flow ? feeAprPct(flow.fees24Usd, tvl) : undefined;
    rows[p.id] = {
      poolId: p.id,
      tvlUsd: tvl,
      volume24Usd: flow?.volume24Usd,
      fees24Usd: flow?.fees24Usd,
      aprPct: apr,
    };
    if (tvl !== undefined) totalTvl = (totalTvl ?? 0) + tvl;
    if (flow) {
      totalVol = (totalVol ?? 0) + flow.volume24Usd;
      totalFees = (totalFees ?? 0) + flow.fees24Usd;
    }
  }

  // TVL sparkline = current total TVL scaled by the cirBTC price trend (TVL tracks the cirBTC value).
  const tvlShape = flowQuery.data?.spark.tvlShape ?? [];
  const tvlSpark =
    totalTvl !== undefined && tvlShape.length
      ? tvlShape.map((ratio) => totalTvl! * ratio)
      : [];

  return {
    rows,
    totals: { tvlUsd: totalTvl, volume24Usd: totalVol, fees24Usd: totalFees },
    spark: { tvl: tvlSpark, volume: flowQuery.data?.spark.volume ?? [], fees: flowQuery.data?.spark.fees ?? [] },
    prices,
    isLoadingTvl: reservesQuery.isLoading,
    isLoadingFlow: flowQuery.isLoading,
  };
}
