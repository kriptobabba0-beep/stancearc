// hooks/useUnstake.ts - FeeArena.unstake(tokenId); enabled only when Settled && position.swept (contract enforces).
//
// WHY THE RECEIPT WAIT IS IMPERATIVE (not the shared reactive useTxToast/useTxReceipt): this hook is
// instantiated inside ClaimUnstakePanel's per-position row. Unstaking an ALREADY-CLAIMED position drops
// the row from its filter (`!s.unstaked || (s.side !== NONE && !s.claimed)` → both clauses false once
// the position is unstaked+claimed) → the row UNMOUNTS, usually BEFORE the receipt resolves. A reactive
// useTxToast/useTxReceipt unmounts with the row and never fires, orphaning the keyed loading toast
// forever (sonner loading toasts never auto-dismiss). An in-flight async fn keeps running after its
// component unmounts, so we resolve the loading→success/reverted/timeout toast IMPERATIVELY inside
// `unstake` via publicClient.waitForTransactionReceipt - that always settles the toast even once the
// row is gone. This is the live v1 claim→unstake flow (a real test path).
import { useCallback, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { useMarketContracts } from '@/lib/contracts';
import { ARC_CHAIN_ID, withGasFloor } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { TX_RECEIPT_TIMEOUT_MS } from '@/hooks/useTxToast';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

const TOAST_ID = 'unstake';

export function useUnstake() {
  const { feeArena } = useMarketContracts();
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  const { writeContractAsync, data: hash, isPending: isWriting } = useArcWriteContract();
  const [error, setError] = useState<Error | undefined>();
  const [isSimulating, setIsSimulating] = useState(false);
  // The imperative receipt-wait state (we do NOT use the reactive useTxReceipt here - see header).
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const unstake = useCallback(
    async ({ tokenId }: { tokenId: bigint }) => {
      setError(undefined);
      setIsSuccess(false);
      try {
        if (!publicClient) throw new Error('No RPC client available.');
        setIsSimulating(true);
        const { request } = await publicClient.simulateContract({
          account: address,
          address: feeArena.address,
          abi: feeArena.abi,
          functionName: 'unstake',
          args: [tokenId],
        });
        setIsSimulating(false);
        // Apply the Arc 20-gwei gas floor so the unstake write is never under-priced (see lib/chain).
        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading('Unstaking', { id: TOAST_ID, description: arcScanTxUrl(tx) });
        bumpPollAfterWrite();
        void qc.refetchQueries({ type: 'active' });

        // IMPERATIVE receipt wait - resolves the keyed loading toast even though this row UNMOUNTS the
        // moment an already-claimed position leaves the ClaimUnstakePanel filter (the reactive
        // useTxToast would never fire after unmount, leaving the sonner spinner orphaned forever - the
        // live bug). This async fn keeps running post-unmount, so the toast is always settled.
        setIsConfirming(true);
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: tx,
            timeout: TX_RECEIPT_TIMEOUT_MS,
          });
          if (receipt.status === 'reverted') {
            toast.error('Unstake reverted', { id: TOAST_ID });
          } else {
            setIsSuccess(true);
            toast.success('Unstaked', { id: TOAST_ID });
          }
        } catch {
          // Receipt timed out / RPC stalled - the unstake may well have CONFIRMED (Arc can be slow to
          // return receipts). Replace the loading spinner with a reassuring, NON-STUCK toast rather than
          // claiming failure; the background poll surfaces the updated state shortly.
          toast.error('Sent - couldn’t confirm yet; your positions will update shortly (or refresh).', {
            id: TOAST_ID,
          });
        } finally {
          setIsConfirming(false);
          // Refetch once the receipt settles (success or timeout) so positions update without a manual
          // refresh - mirrors the success/timeout refetch the shared useTxToast did.
          void qc.refetchQueries({ type: 'active' });
        }
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

  return { unstake, isPending: isSimulating || isWriting || isConfirming, isSuccess, error, hash };
}
