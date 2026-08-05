// hooks/useTokenApproval.ts - read an ERC-20 allowance for a spender + approve once if insufficient.
// Used by the add-liquidity surfaces (ProvideLiquidity + the Arena AddLiquidityModal) to grant the NPM
// the base + USDC it pulls during mint. Approves MAX (uint256 max) so a SINGLE approval covers all
// future mints - the user is not re-prompted every time (only if they manually revoke). The
// `needsApproval` short-circuit (allowance >= requiredAmount) then skips the approve step thereafter.
// All reads pin chainId=Arc; the approve write uses the 20-gwei Arc gas floor with a simulate preflight.
import { useCallback, useState } from 'react';
import { maxUint256 } from 'viem';
import { useAccount, usePublicClient, useReadContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { erc20Abi } from '@/abis';
import { ARC_CHAIN_ID, arcTestnet, withGasFloor } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { useTxToast, useTxReceipt } from '@/hooks/useTxToast';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

export interface TokenApproval {
  /** Current allowance(owner, spender), or undefined while loading. */
  allowance: bigint | undefined;
  /** True when the allowance is insufficient for `requiredAmount` (and the read has resolved). */
  needsApproval: boolean;
  /**
   * True once the allowance read has resolved (allowance !== undefined) OR the read is not yet
   * enabled (no address/token/spender) - meaning the hook won't suddenly flip needsApproval from
   * false→true once data arrives. Callers must wait for this before enabling the "Provide" button
   * to avoid a flash where canMint passes before approvals are known.
   */
  allowanceReady: boolean;
  /** approve(spender, MAX) - one-time unlimited approval, simulate-then-write with the gas floor. */
  approve: () => Promise<`0x${string}` | undefined>;
  isPending: boolean;
  isSuccess: boolean;
  error?: Error;
  hash?: `0x${string}`;
}

/**
 * Allowance read + exact approve for (token -> spender), sized to `requiredAmount`.
 * `token`/`spender` may be undefined while addresses resolve - the read is gated off until both
 * (and the owner) are known. `needsApproval` is false while loading (so the UI doesn't flash a
 * spurious approve step) and only true once a resolved allowance is below the requirement.
 */
export function useTokenApproval(
  token: `0x${string}` | undefined,
  spender: `0x${string}` | undefined,
  requiredAmount: bigint,
  /** Optional human label (e.g. token symbol) used in the lifecycle toast - "Approving <label>". */
  label?: string,
): TokenApproval {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  const { writeContractAsync, data: hash, isPending: isWriting } = useArcWriteContract();
  const [error, setError] = useState<Error | undefined>();
  const [isSimulating, setIsSimulating] = useState(false);

  const readEnabled = !!address && !!token && !!spender;
  const { data: allowance, isLoading: allowanceLoading } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && spender ? [address, spender] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: readEnabled },
  });

  // Per-token toast id so a base-token approve and a USDC approve don't overwrite each other.
  const toastId = `approve-${token ?? 'token'}`;
  const approveLabel = `Approving ${label ?? 'token'}`;

  const {
    isLoading: isConfirming,
    isSuccess,
    isError: isReceiptError,
    data: receipt,
  } = useTxReceipt(hash);

  useTxToast({
    id: toastId,
    hash,
    receipt,
    isSuccess,
    isError: isReceiptError,
    labels: {
      success: `Approved ${label ?? 'token'}`,
      reverted: `Approve ${label ?? 'token'} reverted`,
      error: `Could not confirm the ${label ?? 'token'} approval`,
    },
  });

  const needsApproval =
    requiredAmount > 0n && allowance !== undefined && (allowance as bigint) < requiredAmount;

  // Ready once the read has resolved, or when the read is not enabled (no wallet/token/spender yet -
  // in that state allowance stays undefined but won't flip to a real value, so callers are safe).
  const allowanceReady = !readEnabled || !allowanceLoading;

  const approve = useCallback(async () => {
    setError(undefined);
    try {
      if (!address) throw new Error('Connect your wallet first.');
      if (!publicClient) throw new Error('No RPC client available.');
      if (!token || !spender) throw new Error('Token is still loading - try again in a moment.');
      if (requiredAmount <= 0n) throw new Error('Nothing to approve.');

      setIsSimulating(true);
      const { request } = await publicClient.simulateContract({
        account: address,
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        // MAX approval: one grant covers all future mints so the user isn't re-prompted each time
        // (the allowance >= requiredAmount short-circuit then skips re-approval until they revoke).
        args: [spender, maxUint256],
      });
      setIsSimulating(false);

      // Apply the Arc 20-gwei gas floor so the approve write is never under-priced (see lib/chain).
      const tx = await writeContractAsync(
        withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
      );
      toast.loading(approveLabel, { id: toastId, description: arcScanTxUrl(tx) });
      bumpPollAfterWrite();
      void qc.refetchQueries({ type: 'active' });
      return tx;
    } catch (e) {
      setIsSimulating(false);
      const err = new Error(friendlyError(e));
      setError(err);
      toast.error(err.message, { id: toastId });
      throw err;
    }
  }, [address, publicClient, token, spender, requiredAmount, writeContractAsync, qc, toastId, approveLabel]);

  return {
    allowance: allowance as bigint | undefined,
    needsApproval,
    allowanceReady,
    approve,
    isPending: isSimulating || isWriting || isConfirming,
    isSuccess,
    error,
    hash,
  };
}
