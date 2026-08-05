'use client';

// hooks/useFeesSettled.ts - cumulative TOTAL trading fees the arena has collected + settled across the
// ACTIVE market's history, summed from the entry-anchored (v3) PositionProcessed event (feeBase + feeUSDC
// per processed position). This is the HONEST "fees settled to date" figure: it counts every position's
// epoch fees - winner-KEPT fees included - not just the losers' forfeited pot (potBase/potUSDC), which is
// a small slice. Built purely from event logs (no indexer), cached + re-keyed per market like the
// leaderboard/history hooks. v1/v2 arenas don't emit PositionProcessed, so the query is v3-only.
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import type { AbiEvent } from 'viem';
import { wagmiConfig } from '@/lib/wagmi';
import { arcTestnet } from '@/lib/chain';
import { feeArenaV3Abi } from '@/abis';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV3Market } from '@/lib/markets';
import { getEventLogsChunked } from '@/lib/events';
import type { DecodedLog } from '@/hooks/useEpochHistory';

/** Raw cumulative fee legs (base at the market's base decimals, USDC at 6dp). */
export interface FeesSettled {
  feeBase: bigint;
  feeUSDC: bigint;
}

function eventAbiFrom(abi: readonly unknown[], name: string): AbiEvent {
  const item = (abi as { type: string; name?: string }[]).find((e) => e.type === 'event' && e.name === name);
  if (!item) throw new Error(`[useFeesSettled] FeeArena ABI missing event ${name}`);
  return item as AbiEvent;
}
const POSITION_PROCESSED = eventAbiFrom(feeArenaV3Abi, 'PositionProcessed');

const argOf = (log: DecodedLog, key: string): unknown =>
  log.args && !Array.isArray(log.args) ? (log.args as Record<string, unknown>)[key] : undefined;

/** Sum the feeBase + feeUSDC legs across PositionProcessed logs. Pure, so it is unit-testable. */
export function sumFeesSettled(logs: DecodedLog[]): FeesSettled {
  let feeBase = 0n;
  let feeUSDC = 0n;
  for (const l of logs) {
    feeBase += (argOf(l, 'feeBase') as bigint) ?? 0n;
    feeUSDC += (argOf(l, 'feeUSDC') as bigint) ?? 0n;
  }
  return { feeBase, feeUSDC };
}

/** react-query result for the active market's cumulative settled fees. v1/v2 markets resolve to zero. */
export function useFeesSettled(): UseQueryResult<FeesSettled, Error> {
  const market = useActiveMarket();
  const chainId = useChainId();
  const arena = market.feeArena;
  const fromBlock = market.fromBlock ?? 0n;
  const v3 = isV3Market(market);

  return useQuery<FeesSettled, Error>({
    queryKey: ['feesSettled', chainId, market.id, arena, fromBlock.toString()],
    queryFn: async () => {
      if (!v3) return { feeBase: 0n, feeUSDC: 0n }; // only the entry-anchored arena emits PositionProcessed
      const client = getPublicClient(wagmiConfig, { chainId: arcTestnet.id });
      if (!client) throw new Error('No RPC client configured.');
      const toBlock = await client.getBlockNumber();
      const logs = await getEventLogsChunked(client, { address: arena, event: POSITION_PROCESSED, fromBlock, toBlock });
      return sumFeesSettled(logs);
    },
    staleTime: 30_000,
    retry: 1,
  });
}
