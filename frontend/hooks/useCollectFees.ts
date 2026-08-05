// hooks/useCollectFees.ts - collect a liquidity position's accrued TRADING FEES to the wallet
// WITHOUT removing any liquidity. This is the "claim" for liquidity-only providers (those who
// added liquidity but did not stake into an epoch): the swap bot generates continuous volume,
// each swap pays the pool's 0.3% fee to in-range LPs, and this sweeps those fees out.
//
// Unlike useRemoveLiquidity (which decreaseLiquidity+collects 100% - burning the position), this
// calls ONLY NPM.collect({ tokenId, recipient: owner, amount0Max: max, amount1Max: max }). On a
// position that still has liquidity the NPM pokes the pool (burn 0) to realize the latest fees and
// then sweeps just those owed fees, leaving the principal in place.
//
// Also exports usePositionFees(tokenId): a polled STATIC simulate of collect() that returns the
// currently-collectable (amount0, amount1) so the UI can show "unclaimed fees" and disable the
// button when there's nothing to collect.
//
// Receipt-wait is IMPERATIVE (mirrors useRemoveLiquidity) so the keyed toast settles even if the
// row re-renders on the post-collect refetch.
import { useCallback, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { npm } from '@/lib/contracts';
import { ARC_CHAIN_ID, arcTestnet, withGasFloor } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { TX_RECEIPT_TIMEOUT_MS } from '@/hooks/useTxToast';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

const MAX_UINT128 = (1n << 128n) - 1n;
const toastIdFor = (tokenId: bigint) => `collect-fees-${tokenId}`;

/** The collectable (amount0, amount1) for a position, mapped to base/USDC by pool orientation. */
export interface PositionFees {
  /** token0 amount (pool ordering). */
  amount0: bigint;
  /** token1 amount (pool ordering). */
  amount1: bigint;
}

/**
 * Polled STATIC simulate of NPM.collect(max,max) for a position - returns the fees that WOULD be
 * collected right now (eth_call pokes the pool so it reflects live accrued fees). Used to show the
 * unclaimed amount + gate the Collect button. Enabled only when connected. Best-effort: a revert
 * (e.g. transiently not-owner during a re-org) just yields undefined and the UI falls back.
 */
export function usePositionFees(tokenId: bigint) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  return useQuery<PositionFees>({
    queryKey: ['positionFees', arcTestnet.id, tokenId.toString(), address],
    enabled: !!address && !!publicClient,
    refetchInterval: 10_000,
    queryFn: async () => {
      const { result } = await publicClient!.simulateContract({
        account: address!,
        address: npm.address,
        abi: npm.abi,
        functionName: 'collect',
        args: [{ tokenId, recipient: address!, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
      });
      const [amount0, amount1] = result as readonly [bigint, bigint];
      return { amount0, amount1 };
    },
  });
}

export function useCollectFees() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  const { writeContractAsync, data: hash, isPending: isWriting } = useArcWriteContract();
  const [error, setError] = useState<Error | undefined>();
  const [isSimulating, setIsSimulating] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const collect = useCallback(
    async ({ tokenId }: { tokenId: bigint }) => {
      setError(undefined);
      setIsSuccess(false);
      const id = toastIdFor(tokenId);
      try {
        if (!address) throw new Error('Connect your wallet first.');
        if (!publicClient) throw new Error('No RPC client available.');

        setIsSimulating(true);
        // MANDATORY preflight - also returns the would-be (amount0, amount1) so we can refuse a
        // pointless 0-fee collect with a clear message instead of a wasted tx.
        const { request, result } = await publicClient.simulateContract({
          account: address,
          address: npm.address,
          abi: npm.abi,
          functionName: 'collect',
          args: [{ tokenId, recipient: address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
        });
        setIsSimulating(false);
        const [a0, a1] = result as readonly [bigint, bigint];
        if (a0 === 0n && a1 === 0n) {
          throw new Error('No fees to collect yet - this position hasn’t earned any fees since your last collect.');
        }

        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading('Collecting fees', { id, description: arcScanTxUrl(tx) });
        bumpPollAfterWrite();
        void qc.refetchQueries({ type: 'active' });

        setIsConfirming(true);
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: tx,
            timeout: TX_RECEIPT_TIMEOUT_MS,
          });
          if (receipt.status === 'reverted') {
            toast.error('Collect fees reverted', { id });
          } else {
            setIsSuccess(true);
            toast.success('Fees collected to your wallet', { id });
          }
        } catch {
          toast.error('Sent - couldn’t confirm yet; your balance will update shortly (or refresh).', { id });
        } finally {
          setIsConfirming(false);
          void qc.refetchQueries({ type: 'active' });
        }
        return tx;
      } catch (e) {
        setIsSimulating(false);
        const err = new Error(friendlyError(e));
        setError(err);
        toast.error(err.message, { id });
        throw err;
      }
    },
    [address, publicClient, writeContractAsync, qc],
  );

  return { collect, isPending: isSimulating || isWriting || isConfirming, isSuccess, error, hash };
}
