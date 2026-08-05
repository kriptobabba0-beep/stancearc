// hooks/useEpoch.ts - polled FeeArena.getEpoch(id) -> EpochView; enabled only when id is set.
//
// VERSION-AWARE: a v1 market's getEpoch(id) returns the collapsed EpochView (used verbatim). A v2
// market's getEpoch(id) returns the RAW EpochV2 struct (NO epochId, raw 6-phase, conviction fields),
// so we run the EpochV2 -> EpochView adapter (lib/epochV2.ts), injecting the queried `epochId` (the
// raw struct has no epochId field). Either way `data` is an EpochView consumers read unchanged.
import { useMemo } from 'react';
import { useReadContract } from 'wagmi';
import { useMarketContracts } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV2Market, isV3Market } from '@/lib/markets';
import { arcTestnet } from '@/lib/chain';
import type { EpochView } from '@/lib/types';
import { adaptEpochV2, type RawEpochV2 } from '@/lib/epochV2';
import { adaptEpochV3, type RawEpochV3 } from '@/lib/epochV3';
import { usePollInterval } from '@/hooks/usePollInterval';

export function useEpoch(epochId: bigint | undefined) {
  const { feeArena } = useMarketContracts();
  const market = useActiveMarket();
  const v2 = isV2Market(market);
  const v3 = isV3Market(market);
  const interval = usePollInterval();

  const q = useReadContract({
    ...feeArena,
    functionName: 'getEpoch',
    args: epochId !== undefined ? [epochId] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: epochId !== undefined, refetchInterval: interval },
  });

  const data = useMemo<EpochView | undefined>(() => {
    if (!q.data) return undefined;
    if (v3) return adaptEpochV3(q.data as RawEpochV3); // v3 view carries its own epochId
    if (!v2) return q.data as EpochView;
    // v2: adapt the raw struct, injecting the queried epochId (guaranteed defined when q.data exists).
    return adaptEpochV2(q.data as RawEpochV2, epochId ?? 0n);
  }, [v2, v3, q.data, epochId]);

  return { ...q, data } as ReturnType<typeof useReadContract> & { data: EpochView | undefined };
}
