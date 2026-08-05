'use client';

// hooks/usePoolStats.ts - REAL on-chain analytics for the Pool list page, in two independent queries so
// the page is snappy and degrades gracefully:
//
//   1. RESERVES (fast)  - multicall balanceOf(token0/token1)@pool + slot0 for every registry pool →
//                         per-token USD prices (each token priced off its own USDC pool; USDC≈1) and
//                         per-pool TVL. This is the headline number AND the list's sort key, so it must
//                         land first; it's a handful of reads.
//   2. FLOW (slower)    - estimate a ~24h block window, then chunked getLogs of each pool's Swap events
//                         over that window → 24h volume (Σ swap notionals), fees (volume × fee tier),
//                         APR (annualised fees / TVL) and the header sparklines. Heavier (event scan),
//                         so it fills in after; while it loads the volume/fees/APR cells show a dash.
//
// Honest framing (see lib/poolStats): every figure restates real on-chain data - nothing fabricated.
import { useQuery } from '@tanstack/react-query';
import { getPublicClient } from 'wagmi/actions';
import type { AbiEvent } from 'viem';
import { wagmiConfig } from '@/lib/wagmi';
import { arcTestnet } from '@/lib/chain';
import { POOLS, poolById } from '@/lib/pools';
import { erc20Abi, uniswapV3PoolAbi } from '@/abis';
import { sqrtPriceX96ToPrice } from '@/lib/rangeMath';
import { decodeSlot0 } from '@/lib/rangeDisplay';
import { getEventLogsChunked } from '@/lib/events';
import {
  tvlUsd as computeTvl,
  swapNotionalUsd,
  feesFromVolume,
  feeAprPct,
  bucketSeries,
  type UsdPriceMap,
  type TimedValue,
} from '@/lib/poolStats';

// The Uniswap-V3 pool Swap event (NOT in uniswapV3PoolAbi, which only carries the view fns we read for
// the swap quote). amount0/amount1 are SIGNED token deltas; sqrtPriceX96 is the post-swap price.
const SWAP_EVENT = {
  type: 'event',
  name: 'Swap',
  inputs: [
    { name: 'sender', type: 'address', indexed: true },
    { name: 'recipient', type: 'address', indexed: true },
    { name: 'amount0', type: 'int256', indexed: false },
    { name: 'amount1', type: 'int256', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ],
} as const satisfies AbiEvent;

/** Number of sparkline buckets across the 24h window. */
const SPARK_BUCKETS = 24;
/** Hard cap on the scanned block window so a fast-block chain can't trigger an unbounded getLogs sweep. */
const MAX_WINDOW_BLOCKS = 120_000n;
/** Probe span used to estimate block time (blocks behind tip). */
const PROBE_BLOCKS = 20_000n;

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

/** token0/token1 decimals for a pool from its base/quote orientation. */
function poolDecs(poolId: string): { dec0: number; dec1: number } {
  const p = poolById(poolId)!;
  return p.baseIsToken0
    ? { dec0: p.base.decimals, dec1: p.quote.decimals }
    : { dec0: p.quote.decimals, dec1: p.base.decimals };
}

/** Derive a symbol→USD map: USDC≈1; each volatile/eur leg from ITS OWN USDC pool's slot0 price. */
function derivePrices(slot0ByPool: Record<string, ReturnType<typeof decodeSlot0>>): UsdPriceMap {
  const prices: UsdPriceMap = { USDC: 1 };
  for (const p of POOLS) {
    const s = slot0ByPool[p.id];
    if (!s || p.quote.symbol !== 'USDC') continue; // USD price only from a USDC-quoted pool
    const { dec0, dec1 } = poolDecs(p.id);
    const usdcPerBase = sqrtPriceX96ToPrice(s.sqrtPriceX96, dec0, dec1, p.baseIsToken0);
    if (usdcPerBase > 0) prices[p.base.symbol] = usdcPerBase;
  }
  return prices;
}

/** Multicall every pool's reserves (balanceOf token0/token1 @ pool) + slot0, in one batch. */
async function readReserves(client: NonNullable<ReturnType<typeof getPublicClient>>) {
  const contracts = POOLS.flatMap((p) => [
    { address: p.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] } as const,
    { address: p.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] } as const,
    { address: p.address, abi: uniswapV3PoolAbi, functionName: 'slot0' } as const,
  ]);
  const res = await client.multicall({ contracts, allowFailure: true });

  const slot0ByPool: Record<string, ReturnType<typeof decodeSlot0>> = {};
  const reserves: Record<string, { bal0?: bigint; bal1?: bigint }> = {};
  POOLS.forEach((p, i) => {
    const bal0 = res[i * 3]?.status === 'success' ? (res[i * 3].result as bigint) : undefined;
    const bal1 = res[i * 3 + 1]?.status === 'success' ? (res[i * 3 + 1].result as bigint) : undefined;
    const s0 = res[i * 3 + 2]?.status === 'success' ? res[i * 3 + 2].result : undefined;
    reserves[p.id] = { bal0, bal1 };
    slot0ByPool[p.id] = decodeSlot0(s0);
  });
  return { slot0ByPool, reserves };
}

/** Per-pool TVL from reserves + the derived price map. */
function tvlForPool(
  poolId: string,
  reserves: { bal0?: bigint; bal1?: bigint },
  prices: UsdPriceMap,
): number | undefined {
  const p = poolById(poolId)!;
  if (reserves.bal0 === undefined || reserves.bal1 === undefined) return undefined;
  const baseUsd = prices[p.base.symbol];
  const quoteUsd = prices[p.quote.symbol];
  if (baseUsd === undefined || quoteUsd === undefined) return undefined;
  const reserveBaseRaw = p.baseIsToken0 ? reserves.bal0 : reserves.bal1;
  const reserveQuoteRaw = p.baseIsToken0 ? reserves.bal1 : reserves.bal0;
  return computeTvl({
    reserveBaseRaw,
    baseDecimals: p.base.decimals,
    baseUsd,
    reserveQuoteRaw,
    quoteDecimals: p.quote.decimals,
    quoteUsd,
  });
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

  // ── 2. 24h flow: volume / fees / APR / sparklines (slower; event scan) ──────────
  const flowQuery = useQuery({
    queryKey: ['poolStats', 'flow'],
    refetchInterval: 60_000,
    staleTime: 45_000,
    queryFn: async () => {
      const client = getPublicClient(wagmiConfig, { chainId: arcTestnet.id });
      if (!client) throw new Error('no rpc client');

      // Prices (re-read slot0 so this query is self-contained).
      const { slot0ByPool } = await readReserves(client);
      const prices = derivePrices(slot0ByPool);

      // Estimate a ~24h block window: probe block time off the tip, clamp the span.
      const tip = await client.getBlockNumber();
      const probeFrom = tip > PROBE_BLOCKS ? tip - PROBE_BLOCKS : 0n;
      const [tipBlock, probeBlock] = await Promise.all([
        client.getBlock({ blockNumber: tip }),
        client.getBlock({ blockNumber: probeFrom }),
      ]);
      const dt = Number(tipBlock.timestamp - probeBlock.timestamp);
      const dBlocks = Number(tip - probeFrom);
      const secsPerBlock = dt > 0 && dBlocks > 0 ? dt / dBlocks : 2; // sane fallback
      let window = BigInt(Math.max(1, Math.round(86_400 / secsPerBlock)));
      if (window > MAX_WINDOW_BLOCKS) window = MAX_WINDOW_BLOCKS;
      const fromBlock = tip > window ? tip - window : 0n;

      // Scan each pool's Swap events over the window (parallel).
      const perPool = await Promise.all(
        POOLS.map(async (p) => {
          try {
            const logs = await getEventLogsChunked(client, {
              address: p.address,
              event: SWAP_EVENT,
              fromBlock,
              toBlock: tip,
            });
            const { dec0, dec1 } = poolDecs(p.id);
            const quoteUsd = prices[p.quote.symbol] ?? 0;
            const baseUsd = prices[p.base.symbol] ?? 0;
            let volume = 0;
            const volItems: TimedValue[] = [];
            const priceItems: { block: number; price: number }[] = [];
            for (const log of logs) {
              const a0 = log.args.amount0 as bigint;
              const a1 = log.args.amount1 as bigint;
              const quoteRaw = p.baseIsToken0 ? a1 : a0; // quote leg
              const notional = swapNotionalUsd(quoteRaw, p.quote.decimals, quoteUsd);
              volume += notional;
              const blk = Number(log.blockNumber ?? fromBlock);
              volItems.push({ t: blk, v: notional });
              // cirBTC/USDC price series (for the TVL trend sparkline).
              if (p.quote.symbol === 'USDC' && p.base.symbol === 'cirBTC') {
                const price = sqrtPriceX96ToPrice(log.args.sqrtPriceX96 as bigint, dec0, dec1, p.baseIsToken0);
                if (price > 0) priceItems.push({ block: blk, price });
              }
            }
            return { poolId: p.id, volume, volItems, priceItems, baseUsd };
          } catch {
            // RPC hiccup on this pool - contribute nothing rather than failing the whole query.
            return { poolId: p.id, volume: 0, volItems: [] as TimedValue[], priceItems: [], baseUsd: 0 };
          }
        }),
      );

      const feeTier = POOLS[0].feeTier; // all registry pools share the fee tier
      const rowFlow: Record<string, { volume24Usd: number; fees24Usd: number }> = {};
      const allVolItems: TimedValue[] = [];
      const allFeeItems: TimedValue[] = [];
      let cirbtcPriceItems: { block: number; price: number }[] = [];
      for (const r of perPool) {
        const fees = feesFromVolume(r.volume, feeTier);
        rowFlow[r.poolId] = { volume24Usd: r.volume, fees24Usd: fees };
        for (const it of r.volItems) {
          allVolItems.push(it);
          allFeeItems.push({ t: it.t, v: feesFromVolume(it.v, feeTier) });
        }
        if (r.priceItems.length) cirbtcPriceItems = r.priceItems;
      }

      // Sparklines bucketed by BLOCK NUMBER (a uniform proxy for time on a steady chain).
      const volume = bucketSeries(allVolItems, Number(fromBlock), Number(tip), SPARK_BUCKETS);
      const fees = bucketSeries(allFeeItems, Number(fromBlock), Number(tip), SPARK_BUCKETS);
      const tvlSpark = tvlTrend(cirbtcPriceItems, Number(fromBlock), Number(tip), SPARK_BUCKETS);

      return { fromBlock, tip, prices, rowFlow, spark: { volume, fees, tvlShape: tvlSpark } };
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

/**
 * A cirBTC-price trend as RATIOS to the latest price (length `buckets`, oldest → newest). Each bucket
 * takes the last swap price in it; empty buckets carry forward the previous known price; leading gaps
 * use the first known price. Returns an empty array when there are no price samples (caller shows flat).
 */
function tvlTrend(
  priceItems: ReadonlyArray<{ block: number; price: number }>,
  fromBlock: number,
  toBlock: number,
  buckets: number,
): number[] {
  if (!priceItems.length || toBlock <= fromBlock || buckets <= 0) return [];
  const span = toBlock - fromBlock;
  const lastInBucket = new Array<number | undefined>(buckets).fill(undefined);
  for (const { block, price } of priceItems) {
    if (block < fromBlock || block > toBlock) continue;
    let idx = Math.floor(((block - fromBlock) / span) * buckets);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    lastInBucket[idx] = price; // later samples overwrite → "last price in bucket"
  }
  // Forward-fill (and back-fill the leading gap with the first known price).
  const firstKnown = lastInBucket.find((p) => p !== undefined) ?? 0;
  const filled: number[] = [];
  let prev = firstKnown;
  for (let i = 0; i < buckets; i++) {
    const v = lastInBucket[i];
    if (v !== undefined) prev = v;
    filled.push(prev);
  }
  const latest = filled[filled.length - 1] || 1;
  return filled.map((p) => (latest > 0 ? p / latest : 1));
}
