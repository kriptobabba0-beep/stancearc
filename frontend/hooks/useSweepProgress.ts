// hooks/useSweepProgress.ts — polled settlement-processing progress -> {done,total}; gates Claim
// (done===total). v1/v2 expose it as sweepProgress; v3 (entry-anchored) as processProgress — the
// (uint64) -> (uint32,uint32) shape is identical, only the crank it tracks differs.
import { useReadContract } from 'wagmi';
import type { Abi } from 'viem';
import { useMarketContracts } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV3Market } from '@/lib/markets';
import { arcTestnet } from '@/lib/chain';
import type { SweepProgress } from '@/lib/types';

export function useSweepProgress(epochId: bigint | undefined) {
  const { feeArena } = useMarketContracts();
  const v3 = isV3Market(useActiveMarket());
  const q = useReadContract({
    address: feeArena.address,
    abi: feeArena.abi as Abi,
    functionName: v3 ? 'processProgress' : 'sweepProgress',
    args: epochId !== undefined ? [epochId] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: epochId !== undefined, refetchInterval: 2000 },
  });
  const tuple = q.data as readonly [number, number] | undefined;
  const progress: SweepProgress | undefined = tuple ? { done: tuple[0], total: tuple[1] } : undefined;
  return { ...q, data: progress };
}
