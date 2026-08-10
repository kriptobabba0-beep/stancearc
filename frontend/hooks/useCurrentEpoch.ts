// hooks/useCurrentEpoch.ts — polled FeeArena.currentEpoch() -> EpochView; primary phase/countdown source.
//
// VERSION-AWARE: a v1 market's currentEpoch() already returns the collapsed EpochView (epochId-first,
// 4-phase) — used verbatim. A v2 market's currentEpoch() returns the RAW EpochV2 struct (NO epochId,
// raw 6-phase, reordered + conviction fields), so we ALSO read currentEpochId() and run the
// EpochV2 -> EpochView adapter (lib/epochV2.ts). Either way the returned `data` is an EpochView the
// EpochPanel / SideBars / usePollInterval consume unchanged.
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

/** Normalize a raw currentEpoch() decode for any market generation. */
function adapt(raw: unknown, v2: boolean, v3: boolean, epochId: bigint): EpochView {
  if (v3) return adaptEpochV3(raw as RawEpochV3); // v3 carries its own epochId + extras
  if (v2) return adaptEpochV2(raw as RawEpochV2, epochId);
  return raw as EpochView;
}

export function useCurrentEpoch() {
  const { feeArena } = useMarketContracts();
  const market = useActiveMarket();
  const v2 = isV2Market(market);
  const v3 = isV3Market(market);

  // First read (any interval) to size the poll cadence off the (possibly raw) epoch's boundaries.
  const probe = useReadContract({ ...feeArena, functionName: 'currentEpoch', chainId: arcTestnet.id });
  const probeEpoch = probe.data ? adapt(probe.data, v2, v3, 0n) : undefined;
  const refetchInterval = usePollInterval(probeEpoch);

  // v2 ONLY: the raw struct has no epochId — read currentEpochId() separately to inject it.
  const epochIdQuery = useReadContract({
    ...feeArena,
    functionName: 'currentEpochId',
    chainId: arcTestnet.id,
    query: { enabled: v2, refetchInterval },
  });

  // Re-read with the epoch-aware interval (TanStack merges options on the same query key).
  const epochQuery = useReadContract({
    ...feeArena,
    functionName: 'currentEpoch',
    chainId: arcTestnet.id,
    query: { refetchInterval },
  });

  const data = useMemo<EpochView | undefined>(() => {
    if (!epochQuery.data) return undefined;
    const epochId = (epochIdQuery.data as bigint | undefined) ?? 0n;
    return adapt(epochQuery.data, v2, v3, epochId);
  }, [v2, v3, epochQuery.data, epochIdQuery.data]);

  return { ...epochQuery, data } as ReturnType<typeof useReadContract> & {
    data: EpochView | undefined;
  };
}
