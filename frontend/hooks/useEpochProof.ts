'use client';

// hooks/useEpochProof.ts - reconstruct ONE settled epoch from on-chain events for the provably-fair
// detail page. Reads the band from getEpoch(id) (the band is not in any event), then chunked getLogs
// for EpochStarted/Resolved/Settled + EmptyWinnerRollover + Staked + Swept, and runs the PURE
// buildEpochProof aggregator. Cached with react-query, re-keyed by market id + chainId + epochId.
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import type { AbiEvent } from 'viem';
import { wagmiConfig } from '@/lib/wagmi';
import { arcTestnet } from '@/lib/chain';
import { feeArenaAbi } from '@/abis';
import { useActiveMarket } from '@/components/MarketProvider';
import { getEventLogsChunked } from '@/lib/events';
import { buildEpochProof, type EpochProof, type ProofLog } from '@/lib/epochProof';
import type { EpochView } from '@/lib/types';

/** Pull the named event item out of the FeeArena ABI for typed, decoded getLogs. */
function eventAbi(name: string): AbiEvent {
  const item = feeArenaAbi.find((e) => e.type === 'event' && e.name === name);
  if (!item) throw new Error(`[useEpochProof] FeeArena ABI missing event ${name}`);
  return item as AbiEvent;
}

const EPOCH_STARTED = eventAbi('EpochStarted');
const EPOCH_RESOLVED = eventAbi('EpochResolved');
const EPOCH_SETTLED = eventAbi('EpochSettled');
const EMPTY_WINNER_ROLLOVER = eventAbi('EmptyWinnerRollover');
const STAKED = eventAbi('Staked');
const SWEPT = eventAbi('Swept');

/** react-query result for a single epoch's verifiable reconstruction (null when no events exist). */
export function useEpochProof(epochId: bigint | undefined): UseQueryResult<EpochProof | null, Error> {
  const market = useActiveMarket();
  const chainId = useChainId();
  const arena = market.feeArena;
  const fromBlock = market.fromBlock ?? 0n;

  return useQuery<EpochProof | null, Error>({
    queryKey: ['epochProof', chainId, market.id, arena, fromBlock.toString(), epochId?.toString() ?? 'none'],
    enabled: epochId !== undefined,
    queryFn: async () => {
      if (epochId === undefined) return null;
      const client = getPublicClient(wagmiConfig, { chainId: arcTestnet.id });
      if (!client) throw new Error('No RPC client configured.');
      const toBlock = await client.getBlockNumber();

      // The band (bps) is part of the epoch struct, not any event - read it so deriveWinningSide can
      // re-apply the settlement rule. Best-effort: a failed read degrades the band to 0.
      let bandBps = 0;
      try {
        const epoch = (await client.readContract({
          address: arena,
          abi: feeArenaAbi,
          functionName: 'getEpoch',
          args: [epochId],
        })) as EpochView;
        bandBps = Number(epoch.bandBps);
      } catch {
        /* band unknown - deriveWinningSide falls back to a 0 band */
      }

      const [started, resolved, settled, rollovers, staked, swept] = await Promise.all([
        getEventLogsChunked(client, { address: arena, event: EPOCH_STARTED, fromBlock, toBlock }),
        getEventLogsChunked(client, { address: arena, event: EPOCH_RESOLVED, fromBlock, toBlock }),
        getEventLogsChunked(client, { address: arena, event: EPOCH_SETTLED, fromBlock, toBlock }),
        getEventLogsChunked(client, { address: arena, event: EMPTY_WINNER_ROLLOVER, fromBlock, toBlock }),
        getEventLogsChunked(client, { address: arena, event: STAKED, fromBlock, toBlock }),
        getEventLogsChunked(client, { address: arena, event: SWEPT, fromBlock, toBlock }),
      ]);

      return buildEpochProof({
        epochId,
        bandBps,
        started: started as ProofLog[],
        resolved: resolved as ProofLog[],
        settled: settled as ProofLog[],
        rollovers: rollovers as ProofLog[],
        staked: staked as ProofLog[],
        swept: swept as ProofLog[],
      });
    },
    staleTime: 30_000,
    retry: 1,
  });
}
