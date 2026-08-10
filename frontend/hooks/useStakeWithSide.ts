// hooks/useStakeWithSide.ts — version-aware stake.
//   - v1: atomic NPM.safeTransferFrom(user, feeArena, tokenId, encodedSide) — the receiver hook records.
//   - v3 (ENTRY-ANCHORED): approve-if-needed -> payable feeArena.stakeWithSide(tokenId, side,
//     expectedEntryPrice18, maxDeviationBps, hermesBlob){value: pythFee}. The blob and the expected
//     price come from the SAME Hermes update, so the contract anchors the position at (or within
//     maxDeviationBps of) exactly the price the user confirmed — or reverts, never mis-anchors.
// Mandatory simulateContract preflight; Side.NONE rejected client-side; optimistic poll bump on submit.
import { useCallback, useState } from 'react';
import type { Abi } from 'viem';
import { useAccount, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { npm, pythContract, useMarketContracts } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV3Market } from '@/lib/markets';
import { ENV } from '@/lib/env';
import { fetchPythUpdateWithPrice, fetchPythCrossUpdateWithPrice } from '@/lib/pyth';
import { ARC_CHAIN_ID, withGasFloor } from '@/lib/chain';
import { encodeSide, isValidStakeSide } from '@/lib/side';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { useTxToast, useTxReceipt } from '@/hooks/useTxToast';
import { Side } from '@/lib/types';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

const TOAST_ID = 'stake-with-side';

/**
 * v3 default slippage guard: the on-chain entry price may deviate at most 0.50% from the
 * price shown at confirmation, else the stake reverts (EntryPriceDeviation) instead of
 * silently anchoring the user elsewhere.
 */
export const DEFAULT_MAX_DEVIATION_BPS = 50n;

/** Human label for a side (UP/DOWN/RANGE) used in the toast wording. */
function sideLabel(side: Side): string {
  return Side[side] ?? 'side';
}

export function useStakeWithSide() {
  const { feeArena } = useMarketContracts();
  const v3 = isV3Market(useActiveMarket());
  const market = useActiveMarket();
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
      success: 'Staked — your position is in the arena',
      reverted: 'Stake reverted — your position is not staked',
      error: 'Could not confirm the stake',
    },
  });

  const stake = useCallback(
    async ({ tokenId, side }: { tokenId: bigint; side: Side }) => {
      setError(undefined);
      try {
        if (!address) throw new Error('Connect your wallet first.');
        if (!isValidStakeSide(side)) throw new Error('Choose UP, DOWN, or RANGE.');
        if (!publicClient) throw new Error('No RPC client available.');
        setIsSimulating(true);

        if (v3) {
          // ── v3 ENTRY-ANCHORED stake ───────────────────────────────────────────────
          // 1) ONE Hermes update supplies both the on-chain blob AND the expected price. For a CROSS
          // market (e.g. cirBTC/EURC = BTC/EUR) fetch BOTH feeds + the cross price so the blob refreshes
          // both legs and expectedEntryPrice18 matches the CompositePythOracle's getPrice() on-chain.
          const { updateData, price18 } = market.quoteFeedId
            ? await fetchPythCrossUpdateWithPrice(ENV.HERMES_URL, market.feedId, market.quoteFeedId)
            : await fetchPythUpdateWithPrice(ENV.HERMES_URL, market.feedId);
          // 2) Pyth prices the update (paid as msg.value; the contract refunds excess).
          const fee = (await publicClient.readContract({
            ...pythContract,
            functionName: 'getUpdateFee',
            args: [updateData],
          })) as bigint;
          // 3) The arena PULLS the NFT inside stakeWithSide (NPM.safeTransferFrom(user -> arena)),
          // so the arena must be an approved operator first, else the pull reverts "ERC721: transfer
          // caller is not owner nor approved". Use setApprovalForAll (operator approval) — it persists
          // across stakes, whereas per-token approve() is cleared the moment the NFT enters escrow.
          const approvedForAll = (await publicClient.readContract({
            address: npm.address,
            abi: npm.abi as Abi,
            functionName: 'isApprovedForAll',
            args: [address, feeArena.address],
          })) as boolean;
          if (approvedForAll !== true) {
            const { request: approveReq } = await publicClient.simulateContract({
              account: address,
              address: npm.address,
              abi: npm.abi as Abi,
              functionName: 'setApprovalForAll',
              args: [feeArena.address, true],
            });
            const approveTx = await writeContractAsync(
              withGasFloor(approveReq) as Parameters<typeof writeContractAsync>[0],
            );
            toast.loading('Approving the Arena to escrow your position', { id: TOAST_ID, description: arcScanTxUrl(approveTx) });
            await publicClient.waitForTransactionReceipt({ hash: approveTx });
          }
          // 4) The anchored stake itself (preflight catches window/deviation/pool guards).
          const { request } = await publicClient.simulateContract({
            account: address,
            address: feeArena.address,
            abi: feeArena.abi as Abi,
            functionName: 'stakeWithSide',
            args: [tokenId, side, price18, DEFAULT_MAX_DEVIATION_BPS, updateData],
            value: fee,
          });
          setIsSimulating(false);
          const tx = await writeContractAsync(
            withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
          );
          toast.loading(`Staking ${sideLabel(side)} — anchoring your entry price`, {
            id: TOAST_ID,
            description: arcScanTxUrl(tx),
          });
          bumpPollAfterWrite();
          void qc.refetchQueries({ type: 'active' });
          return tx;
        }

        // ── v1 stake: atomic safeTransferFrom with the side payload ─────────────────
        const data = encodeSide(side);
        // MANDATORY preflight — catches closed-window / bad-encoding / wrong-pool before signing.
        const { request } = await publicClient.simulateContract({
          account: address,
          address: npm.address,
          abi: npm.abi,
          functionName: 'safeTransferFrom',
          args: [address, feeArena.address, tokenId, data],
        });
        setIsSimulating(false);
        // Apply the Arc 20-gwei gas floor so the stake write is never under-priced (see lib/chain).
        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading(`Staking ${sideLabel(side)}`, { id: TOAST_ID, description: arcScanTxUrl(tx) });
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
    [v3, market.feedId, address, publicClient, writeContractAsync, feeArena.address, feeArena.abi, qc],
  );

  return { stake, isPending: isSimulating || isWriting || isConfirming, isSuccess, error, hash };
}
