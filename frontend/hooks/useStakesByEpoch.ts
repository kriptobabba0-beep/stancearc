// hooks/useStakesByEpoch.ts — polled getStakesByEpoch(id) -> StakeView[]; per-side bars source.
//
// VERSION-AWARE READ SURFACE: v2 moved getStakesByEpoch OFF the arena onto the FeeArenaV2Lens (the v2
// arena has no getStakesByEpoch). useReadSurface() resolves to the Lens for v2 and the arena for v1;
// the signature + decoded StakeView tuple are identical, so callers are unchanged.
import { useReadContract } from 'wagmi';
import type { Abi } from 'viem';
import { useReadSurface } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';
import type { StakeView } from '@/lib/types';
import { usePollInterval } from '@/hooks/usePollInterval';

export function useStakesByEpoch(epochId: bigint | undefined) {
  const surface = useReadSurface();
  const interval = usePollInterval();
  // `surface.abi` is a union of the v1 arena / v2 Lens ABIs; widen to Abi so useReadContract doesn't
  // try to reconcile getStakesByEpoch across both precise ABIs (the runtime call is identical).
  return useReadContract({
    address: surface.address,
    abi: surface.abi as Abi,
    functionName: 'getStakesByEpoch',
    args: epochId !== undefined ? [epochId] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: epochId !== undefined, refetchInterval: interval },
  }) as ReturnType<typeof useReadContract> & { data: readonly StakeView[] | undefined };
}
