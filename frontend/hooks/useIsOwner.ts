// hooks/useIsOwner.ts - FeeArena.owner() === connected account (contract still enforces regardless).
'use client';

import { useAccount, useReadContract } from 'wagmi';
import { useMarketContracts } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';

/** owner() === connected account. Contract enforces ownership regardless of this gate. */
export function useIsOwner(): { isOwner: boolean; isLoading: boolean; owner?: `0x${string}` } {
  const { feeArena } = useMarketContracts();
  const { address } = useAccount();
  const { data: ownerData, isLoading } = useReadContract({
    address: feeArena.address,
    abi: feeArena.abi,
    functionName: 'owner',
    chainId: arcTestnet.id,
    query: { staleTime: 30_000 },
  });
  const owner = ownerData as `0x${string}` | undefined;
  const isOwner =
    !!address && !!owner && owner.toLowerCase() === address.toLowerCase();
  return { isOwner, isLoading, owner };
}
