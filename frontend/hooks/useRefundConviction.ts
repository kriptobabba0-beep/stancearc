// hooks/useRefundConviction.ts - FeeArena **v2** refundConviction: reclaim a WINNING position's
// conviction principal 1:1 (USDC), decoupled from the sqrt pot claim.
//
// Without this a v2 winner's staked conviction is structurally STUCK - the arena custodies it and only
// `refundConviction(epochId, tokenId, recipient)` releases it. Gated on (Settled && side==winner &&
// !refunded) on-chain; the UI gates the button on the Lens previewRefund.refundable first.
//
// recipient defaults to the connected wallet (recipient == address(0) routes to the position owner
// on-chain); an explicit override lets a blocklisted owner redirect the refund to a clean address.
// Reuses the repo write pattern: simulateContract preflight, withGasFloor (Arc 20-gwei floor),
// per-id useTxToast lifecycle, bumpPollAfterWrite + an immediate active-query refetch, friendlyError.
//
// v2-ONLY: there is no v1 conviction refund. Callers must only invoke this for a v2 market.
import { useCallback, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { useMarketContracts } from '@/lib/contracts';
import { ARC_CHAIN_ID, withGasFloor } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { useTxToast, useTxReceipt } from '@/hooks/useTxToast';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

const TOAST_ID = 'refund-conviction';

export interface RefundConvictionArgs {
  epochId: bigint;
  tokenId: bigint;
  /**
   * Where the USDC conviction principal is paid. Defaults to the connected wallet. Pass a clean address
   * to redirect a blocklisted owner's refund.
   */
  recipient?: `0x${string}`;
}

export function useRefundConviction() {
  const { feeArena } = useMarketContracts();
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
      success: 'Conviction refunded',
      reverted: 'Refund reverted',
      error: 'Could not confirm the refund',
    },
  });

  const refundConviction = useCallback(
    async ({ epochId, tokenId, recipient }: RefundConvictionArgs) => {
      setError(undefined);
      try {
        if (!publicClient) throw new Error('No RPC client available.');
        const to = recipient ?? address ?? (`0x${'0'.repeat(40)}` as const);
        setIsSimulating(true);
        const { request } = await publicClient.simulateContract({
          account: address,
          address: feeArena.address,
          abi: feeArena.abi,
          functionName: 'refundConviction',
          args: [epochId, tokenId, to],
        });
        setIsSimulating(false);
        // Apply the Arc 20-gwei gas floor so the refund write is never under-priced (see lib/chain).
        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading('Refunding conviction', { id: TOAST_ID, description: arcScanTxUrl(tx) });
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
    [address, publicClient, writeContractAsync, feeArena.address, feeArena.abi, qc],
  );

  return { refundConviction, isPending: isSimulating || isWriting || isConfirming, isSuccess, error, hash };
}
