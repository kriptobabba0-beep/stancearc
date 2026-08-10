// lib/poolFlow.ts — the Pool page's 24h numbers: volume, fees and the header sparklines.
//
// This is the expensive half of the pool stats, and it lives here rather than in the hook
// because it now runs on the SERVER. The reason is a hard limit, not a preference: Arc caps
// eth_getLogs at a 10,000-block range, and 24h of Arc is about 169,000 blocks, so the scan is
// roughly 17 windows per pool however it is written. Done in the browser that was 40-odd
// round trips per visitor and about nine seconds of waiting, every visit. Done once on the
// server and cached, it is one small fetch each.
//
// The maths is unchanged — every figure still restates real on-chain data. What changed is
// who pays for it and how often.
import type { AbiEvent, PublicClient } from 'viem';
import { POOLS, poolById } from '@/lib/pools';
import { erc20Abi, uniswapV3PoolAbi } from '@/abis';
import { sqrtPriceX96ToPrice } from '@/lib/rangeMath';
import { decodeSlot0 } from '@/lib/rangeDisplay';
import { getEventLogsChunked } from '@/lib/events';
import {
  tvlUsd as computeTvl,
  swapNotionalUsd,
  feesFromVolume,
  bucketSeries,
  type UsdPriceMap,
  type TimedValue,
} from '@/lib/poolStats';

// The Uniswap-V3 pool Swap event (NOT in uniswapV3PoolAbi, which only carries the view fns we read
// for the swap quote). amount0/amount1 are SIGNED token deltas; sqrtPriceX96 is the post-swap price.
export const SWAP_EVENT = {
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
/**
 * Ceiling on the scanned span, so a chain that speeds up can never turn this into an unbounded
 * sweep. Sized to hold a full day at Arc's ~0.51s blocks (~169k) with room to spare: the old
 * 120k cap silently made "24h volume" a 17-hour figure.
 */
const MAX_WINDOW_BLOCKS = 200_000n;
/** Probe span used to estimate block time (blocks behind tip). */
const PROBE_BLOCKS = 20_000n;

/** What the Pool page needs that cannot be read in a single multicall. */
export interface PoolFlow {
  prices: UsdPriceMap;
  rowFlow: Record<string, { volume24Usd: number; fees24Usd: number }>;
  spark: { volume: number[]; fees: number[]; tvlShape: number[] };
}

/** token0/token1 decimals for a pool from its base/quote orientation. */
export function poolDecs(poolId: string): { dec0: number; dec1: number } {
  const p = poolById(poolId)!;
  return p.baseIsToken0
    ? { dec0: p.base.decimals, dec1: p.quote.decimals }
    : { dec0: p.quote.decimals, dec1: p.base.decimals };
}

/** Derive a symbol→USD map: USDC≈1; each volatile/eur leg from ITS OWN USDC pool's slot0 price. */
export function derivePrices(slot0ByPool: Record<string, ReturnType<typeof decodeSlot0>>): UsdPriceMap {
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
export async function readReserves(client: PublicClient) {
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
export function tvlForPool(
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

/**
 * A cirBTC-price trend as RATIOS to the latest price (length `buckets`, oldest → newest). Each bucket
 * takes the last swap price in it; empty buckets carry forward the previous known price; leading gaps
 * use the first known price. Returns an empty array when there are no price samples (caller shows flat).
 */
export function tvlTrend(
  priceItems: ReadonlyArray<{ block: number; price: number }>,
  fromBlock: number,
  toBlock: number,
  buckets: number,
): number[] {
  if (!priceItems.length || toBlock <= fromBlock || buckets <= 0) return [];
  const span = toBlock - fromBlock;
  const lastInBucket = new Array<number | undefined>(buckets).fill(undefined);
  for (const { block, price } of priceItems) {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(((block - fromBlock) / span) * buckets)));
    lastInBucket[idx] = price;
  }
  const first = priceItems[0].price;
  const filled: number[] = [];
  let carry = first;
  for (let i = 0; i < buckets; i++) {
    const v = lastInBucket[i];
    if (v !== undefined) carry = v;
    filled.push(carry);
  }
  const latest = filled[filled.length - 1];
  if (!(latest > 0)) return [];
  return filled.map((p) => p / latest);
}

/**
 * Scan ~24h of Swap events across every registry pool and reduce them to the page's figures.
 *
 * Expensive by nature — this is the call the API route caches.
 */
export async function computePoolFlow(client: PublicClient): Promise<PoolFlow> {
  // Prices (re-read slot0 so this is self-contained).
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
        return { poolId: p.id, volume, volItems, priceItems };
      } catch {
        // RPC hiccup on this pool — contribute nothing rather than failing the whole scan.
        return { poolId: p.id, volume: 0, volItems: [] as TimedValue[], priceItems: [] };
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
  return {
    prices,
    rowFlow,
    spark: {
      volume: bucketSeries(allVolItems, Number(fromBlock), Number(tip), SPARK_BUCKETS),
      fees: bucketSeries(allFeeItems, Number(fromBlock), Number(tip), SPARK_BUCKETS),
      tvlShape: tvlTrend(cirbtcPriceItems, Number(fromBlock), Number(tip), SPARK_BUCKETS),
    },
  };
}
