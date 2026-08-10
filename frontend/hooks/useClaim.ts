// hooks/useClaim.ts — version-aware FeeArena claim; pays owner regardless of caller; optimistic disable.
//
// VERSION-AWARE WRITE SURFACE:
//   - v1: claim(uint256 epochId, uint256 tokenId)            — 2 args, payout always routed to the owner.
//   - v2: claim(uint64 epochId, uint256 tokenId, address recipient) — 3 args. recipient defaults to the
//         connected address (recipient == address(0) routes to the position owner on-chain); an optional
//         `recipient` override lets a blocklisted owner redirect the sqrt pot share to a clean address.
// Both reuse the repo write pattern: simulateContract preflight, withGasFloor (Arc 20-gwei floor),
// per-id useTxToast lifecycle, bumpPollAfterWrite + an immediate active-query refetch, friendlyError.
import { useCallback, useState } from 'react';
import type { Abi } from 'viem';
import { useAccount, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { useMarketContracts } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV2Market, isV3Market } from '@/lib/markets';
import { ARC_CHAIN_ID, withGasFloor } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { useTxToast, useTxReceipt } from '@/hooks/useTxToast';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

const TOAST_ID = 'claim';

export interface ClaimArgs {
  epochId: bigint;
  tokenId: bigint;
  /**
   * v2 ONLY: where the sqrt pot share is paid. Defaults to the connected wallet. Pass a clean address
   * to redirect a blocklisted owner's payout. Ignored for v1 (the v1 arena always pays the position
   * owner; it has no recipient parameter).
   */
  recipient?: `0x${string}`;
}

export function useClaim() {
  const { feeArena } = useMarketContracts();
  const market = useActiveMarket();
  const v2 = isV2Market(market);
  const v3 = isV3Market(market);
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  const { writeContractAsync, data: hash, isPending: isWriting } = useArcWriteContract();
  const [error, setError] = useState<Error | undefined>();
  const [isSimulating, setIsSimulating] = useState(false);
  const {
    isLoading: isConfirming,
    isSuccess,
    isError: isReceiptError,
    data: receipt,
  } = useTxReceipt(hash);

  useTxToast({
    id: TOAST_ID,
    hash,
    receipt,
    isSuccess,
    isError: isReceiptError,
    labels: {
      success: 'Claimed',
      reverted: 'Claim reverted',
      error: 'Could not confirm the claim',
    },
  });

  const claim = useCallback(
    async ({ epochId, tokenId, recipient }: ClaimArgs) => {
      setError(undefined);
      try {
        if (!publicClient) throw new Error('No RPC client available.');
        // v2 claim takes a recipient (3 args); v3 (entry-anchored) takes ONLY the tokenId (the
        // position knows its epoch, payout always to the owner); v1 is the 2-arg form.
        const args: readonly unknown[] = v2
          ? [epochId, tokenId, recipient ?? address ?? (`0x${'0'.repeat(40)}` as const)]
          : v3
            ? [tokenId]
            : [epochId, tokenId];
        setIsSimulating(true);
        // The arena abi is a v1|v2 union and `claim` has a different arity per version; widen to Abi so
        // viem doesn't reconcile the two overloads (the encoded call matches the resolved version).
        const { request } = await publicClient.simulateContract({
          account: address,
          address: feeArena.address,
          abi: feeArena.abi as Abi,
          functionName: 'claim',
          args,
        });
        setIsSimulating(false);
        // Apply the Arc 20-gwei gas floor so the claim write is never under-priced (see lib/chain).
        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading('Claiming', { id: TOAST_ID, description: arcScanTxUrl(tx) });
        bumpPollAfterWrite();
        void qc.refetchQueries({ type: 'active' });
        return tx;
      } catch (e) {
        setIsSimulating(false);
        const err = new Error(friendlyError(e));
        setError(err);
        toast.error(err.message, { id: TOAST_ID });
        throw err;
      }
    },
    [v2, v3, address, publicClient, writeContractAsync, feeArena.address, feeArena.abi, qc],
  );

  return { claim, isPending: isSimulating || isWriting || isConfirming, isSuccess, error, hash };
}
