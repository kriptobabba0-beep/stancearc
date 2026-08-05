// hooks/useStakeWithConviction.ts - FeeArena **v2** conviction stake.
//
// v2 stake is a USDC-conviction parimutuel: the staker posts a bounded USDC conviction [minConv,maxConv]
// for their side, which the arena pulls via transferFrom, AND the arena pulls the LP NFT itself. So the
// flow is up to THREE txs:
//   1. USDC APPROVE - if allowance(user, arena) < conviction, approve(arena, conviction) (EXACT, never MAX).
//   2. NFT APPROVE  - if !NPM.isApprovedForAll(user, arena), NPM.setApprovalForAll(arena, true).
//   3. STAKE        - stakeWithConviction(tokenId, side, conviction) on the v2 arena.
// All reuse the repo write pattern: simulateContract preflight, withGasFloor (Arc 20-gwei floor),
// useTxToast lifecycle, bumpPollAfterWrite + an immediate active-query refetch, friendlyError.
//
// WHY THE NFT APPROVE (live-bug fix): FeeArenaV2.stakeWithConviction (src/FeeArenaV2.sol) has the ARENA
// call `INonfungiblePositionManager(NPM).safeTransferFrom(msg.sender, address(this), tokenId, ...)` - the
// arena PULLS the NFT out of the user's wallet. For an ERC-721 pull the caller (the arena) must be an
// approved operator (or per-token approved) for that NFT, else it reverts "ERC721: transfer caller is
// not owner nor approved". (v1's useStakeWithSide is different: the USER calls safeTransferFrom directly,
// so no approval is needed there.) We use setApprovalForAll (operator approval) because per-token
// approve() is cleared the moment the NFT moves into escrow - operator approval persists across stakes.
//
// NOTE: msg.sender must NOT be the keeper/owner (the arena enforces operator-exclusion) - a normal
// user wallet stakes fine. Side.NONE and out-of-bounds conviction are rejected client-side first.
import { useCallback, useState } from 'react';
import { useAccount, usePublicClient, useReadContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { npm, usdc, useMarketContracts } from '@/lib/contracts';
import { ARC_CHAIN_ID, arcTestnet, withGasFloor } from '@/lib/chain';
import { isValidStakeSide } from '@/lib/side';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { useTxToast, useTxReceipt, TX_RECEIPT_TIMEOUT_MS } from '@/hooks/useTxToast';
import { Side } from '@/lib/types';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

const TOAST_ID = 'stake-with-conviction';

/** Human label for a side (UP/DOWN/RANGE) used in the toast wording. */
function sideLabel(side: Side): string {
  return Side[side] ?? 'side';
}

/** Conviction bounds (USDC 6dp base units) for the active v2 market - from lib/markets.ts. */
export interface ConvictionBounds {
  minConv: bigint;
  maxConv: bigint;
}

export interface StakeWithConvictionArgs {
  tokenId: bigint;
  side: Side;
  /** At-risk USDC conviction in 6dp base units; must be within [minConv, maxConv]. */
  conviction: bigint;
}

export function useStakeWithConviction(bounds: ConvictionBounds) {
  const { feeArena } = useMarketContracts();
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  const { writeContractAsync, data: hash, isPending: isWriting } = useArcWriteContract();
  const [error, setError] = useState<Error | undefined>();
  const [isSimulating, setIsSimulating] = useState(false);

  // Live USDC allowance(user, arena). Drives the approve short-circuit. Pinned to Arc.
  const { data: allowance } = useReadContract({
    address: usdc.address,
    abi: usdc.abi,
    functionName: 'allowance',
    args: address ? [address, feeArena.address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: !!address },
  });

  // Live NPM.isApprovedForAll(user, arena). Drives the NFT-approve short-circuit (the arena PULLS the
  // LP NFT in stakeWithConviction, so it must be an approved operator). Pinned to Arc.
  const { data: nftApprovedForAll } = useReadContract({
    address: npm.address,
    abi: npm.abi,
    functionName: 'isApprovedForAll',
    args: address ? [address, feeArena.address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: !!address },
  });

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
      success: 'Staked - your position + conviction are in the arena',
      reverted: 'Stake reverted - your position is not staked',
      error: 'Could not confirm the stake',
    },
  });

  const stake = useCallback(
    async ({ tokenId, side, conviction }: StakeWithConvictionArgs) => {
      setError(undefined);
      try {
        if (!address) throw new Error('Connect your wallet first.');
        if (!isValidStakeSide(side)) throw new Error('Choose UP, DOWN, or RANGE.');
        if (!publicClient) throw new Error('No RPC client available.');
        if (conviction < bounds.minConv || conviction > bounds.maxConv) {
          throw new Error(
            `Conviction must be between ${bounds.minConv} and ${bounds.maxConv} (USDC base units).`,
          );
        }

        // STEP 1 - APPROVE (only if the current allowance can't cover the conviction).
        const currentAllowance = (allowance as bigint | undefined) ?? 0n;
        if (currentAllowance < conviction) {
          setIsSimulating(true);
          const { request: approveReq } = await publicClient.simulateContract({
            account: address,
            address: usdc.address,
            abi: usdc.abi,
            functionName: 'approve',
            args: [feeArena.address, conviction], // EXACT conviction, never MAX
          });
          setIsSimulating(false);
          const approveTx = await writeContractAsync(
            withGasFloor(approveReq) as Parameters<typeof writeContractAsync>[0],
          );
          toast.loading('Approving USDC conviction', { id: TOAST_ID, description: arcScanTxUrl(approveTx) });
          // Wait for the approve to mine before staking - the stake's transferFrom needs the allowance live.
          await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: TX_RECEIPT_TIMEOUT_MS });
        }

        // STEP 2 - APPROVE THE LP NFT (operator approval), only if the arena isn't already an operator.
        // The arena PULLS the NFT inside stakeWithConviction (NPM.safeTransferFrom(user -> arena)); that
        // pull reverts "ERC721: transfer caller is not owner nor approved" unless the arena is approved.
        // setApprovalForAll persists across stakes (per-token approve is cleared once the NFT escrows).
        if (nftApprovedForAll !== true) {
          setIsSimulating(true);
          const { request: nftApproveReq } = await publicClient.simulateContract({
            account: address,
            address: npm.address,
            abi: npm.abi,
            functionName: 'setApprovalForAll',
            args: [feeArena.address, true],
          });
          setIsSimulating(false);
          const nftApproveTx = await writeContractAsync(
            withGasFloor(nftApproveReq) as Parameters<typeof writeContractAsync>[0],
          );
          toast.loading('Approving your LP NFT for the arena', { id: TOAST_ID, description: arcScanTxUrl(nftApproveTx) });
          // Wait for the operator approval to mine before staking - the stake's NFT pull needs it live.
          await publicClient.waitForTransactionReceipt({ hash: nftApproveTx, timeout: TX_RECEIPT_TIMEOUT_MS });
        }

        // STEP 3 - STAKE WITH CONVICTION.
        setIsSimulating(true);
        const { request } = await publicClient.simulateContract({
          account: address,
          address: feeArena.address,
          abi: feeArena.abi,
          functionName: 'stakeWithConviction',
          args: [tokenId, side, conviction],
        });
        setIsSimulating(false);
        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading(`Staking ${sideLabel(side)} with conviction`, { id: TOAST_ID, description: arcScanTxUrl(tx) });
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
    [address, publicClient, writeContractAsync, feeArena.address, feeArena.abi, allowance, nftApprovedForAll, bounds.minConv, bounds.maxConv, qc],
  );

  return { stake, isPending: isSimulating || isWriting || isConfirming, isSuccess, error, hash };
}
