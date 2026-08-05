// hooks/usePreviewClaim.ts - polled previewClaim(epochId, tokenId) -> ClaimPreview.
// Reads pinned to ONE blockNumber for projection consistency. FINAL numbers come from HERE, not client math.
//
// VERSION-AWARE READ SURFACE: v2 moved previewClaim OFF the arena onto the FeeArenaV2Lens (the v2
// arena has no previewClaim). useReadSurface() resolves to the Lens for v2 and the arena for v1; the
// (uint64,uint256) -> ClaimPreview signature is identical, so the decoded shape is unchanged.
import { useMemo } from 'react';
import { useReadContract } from 'wagmi';
import type { Abi } from 'viem';
import { useReadSurface } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV3Market } from '@/lib/markets';
import { arcTestnet } from '@/lib/chain';
import type { ClaimPreview } from '@/lib/types';
import { adaptPreviewV3, type RawPreviewV3 } from '@/lib/epochV3';

export function usePreviewClaim(
  epochId: bigint,
  tokenId: bigint,
  opts?: { blockNumber?: bigint },
) {
  const surface = useReadSurface();
  const v3 = isV3Market(useActiveMarket());
  // `surface.abi` is a union (v1 arena / v2 Lens / v3 arena); widen to Abi so useReadContract doesn't
  // try to reconcile previewClaim across the precise ABIs. v3's previewClaim takes ONLY the tokenId
  // (the position knows its epoch) and returns the entry-anchored preview shape, adapted below.
  const q = useReadContract({
    address: surface.address,
    abi: surface.abi as Abi,
    functionName: 'previewClaim',
    args: v3 ? [tokenId] : [epochId, tokenId],
    chainId: arcTestnet.id,
    blockNumber: opts?.blockNumber, // pin all projection reads to one block when provided
    query: { refetchInterval: opts?.blockNumber ? false : 5000 },
  });

  const data = useMemo<ClaimPreview | undefined>(() => {
    if (!q.data) return undefined;
    if (v3) return adaptPreviewV3(q.data as RawPreviewV3);
    return q.data as ClaimPreview;
  }, [v3, q.data]);

  return { ...q, data } as ReturnType<typeof useReadContract> & { data: ClaimPreview | undefined };
}
