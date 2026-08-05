// hooks/useRemoveLiquidity.ts - withdraw / remove-liquidity: pull 100% of a position's liquidity back
// to the connected wallet in ONE transaction.
//
// Flow: read the position's CURRENT liquidity via NPM.positions(tokenId), then batch
//   1) decreaseLiquidity({ tokenId, liquidity: <full>, amount0Min: 0, amount1Min: 0, deadline })
//   2) collect({ tokenId, recipient: owner, amount0Max: uint128.max, amount1Max: uint128.max })
// into a single NPM.multicall([...]) tx (the Uniswap V3 NPM is Multicall). decreaseLiquidity only
// credits the withdrawn token0/token1 to the position's tokensOwed - collect is what actually moves
// them to the wallet - so both are required, and multicall makes them atomic in one signature.
//
// Reuses the repo write pattern: simulateContract preflight -> writeContractAsync(withGasFloor) ->
// submit-time toast.loading + bumpPollAfterWrite + qc.refetchQueries. A 0-liquidity position is
// rejected client-side (nothing to remove) before any simulate/write.
//
// WHY THE RECEIPT WAIT IS IMPERATIVE (not the shared reactive useTxToast/useTxReceipt): this hook is
// instantiated PER-ROW inside LiquidityRow (components/YourLiquidity.tsx). A 100% withdraw makes the
// position vanish from useOwnedPositions, so the LiquidityRow UNMOUNTS - and with it any reactive
// receipt hook - usually BEFORE the receipt resolves (the positions poll wins the race). A reactive
// useTxToast would then never fire, orphaning the keyed loading toast forever (sonner loading toasts
// never auto-dismiss). An in-flight async fn keeps running after its component unmounts, so we resolve
// the loading→success/reverted/timeout toast IMPERATIVELY inside `remove` via
// publicClient.waitForTransactionReceipt - that always settles the toast even once the row is gone.
import { useCallback, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { encodeFunctionData } from 'viem';
import { npm } from '@/lib/contracts';
import { ARC_CHAIN_ID, withGasFloor } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { TX_RECEIPT_TIMEOUT_MS } from '@/hooks/useTxToast';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

// The lifecycle toast id is PER-TOKENID (`remove-liquidity-<tokenId>`) so two rows withdrawing at once
// don't collide on one shared toast (each row's loading/success/error toast is independent).
const TOAST_ID_BASE = 'remove-liquidity';
const toastIdFor = (tokenId: bigint) => `${TOAST_ID_BASE}-${tokenId}`;
const MAX_UINT128 = (1n << 128n) - 1n;
// 20-minute deadline from submit - generous for testnet block times; never the cause of a revert.
const DEADLINE_BUFFER_SECONDS = 20n * 60n;

/** Decoded NPM.positions() - viem decodes this tuple POSITIONALLY (an array; [7]=liquidity), NOT as a
 *  named struct, so read liquidity with a named-then-positional fallback (same as useOwnedPositions).
 *  Only the liquidity field is consumed here. */
interface PositionsResult {
  liquidity?: bigint;
  [index: number]: bigint | undefined;
}

export function useRemoveLiquidity() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  const { writeContractAsync, data: hash, isPending: isWriting } = useArcWriteContract();
  const [error, setError] = useState<Error | undefined>();
  const [isSimulating, setIsSimulating] = useState(false);
  // The imperative receipt-wait state (we do NOT use the reactive useTxReceipt here - see header).
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const remove = useCallback(
    async ({ tokenId }: { tokenId: bigint }) => {
      setError(undefined);
      setIsSuccess(false);
      // Key every toast for this withdrawal to its tokenId so concurrent row withdrawals stay independent.
      const id = toastIdFor(tokenId);
      try {
        if (!address) throw new Error('Connect your wallet first.');
        if (!publicClient) throw new Error('No RPC client available.');

        // 1) Read the position's CURRENT liquidity - we withdraw 100% of whatever is there.
        const position = (await publicClient.readContract({
          address: npm.address,
          abi: npm.abi,
          functionName: 'positions',
          args: [tokenId],
        })) as unknown as PositionsResult;
        // viem decodes positions() positionally - liquidity is index [7]; fall back from the named key
        // (a bare `position.liquidity` was undefined -> "Cannot convert undefined to a BigInt").
        const liquidity = position.liquidity ?? position[7];
        if (liquidity === undefined) {
          throw new Error('Could not read this position’s liquidity - please try again in a moment.');
        }
        if (liquidity === 0n) {
          // Nothing to remove - decreaseLiquidity(0) would revert. Surface a clear message, no write.
          throw new Error('This position has no liquidity to remove.');
        }

        const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_BUFFER_SECONDS;

        // Encode the two inner calls and batch them in one NPM.multicall tx (atomic, one signature).
        const decreaseData = encodeFunctionData({
          abi: npm.abi,
          functionName: 'decreaseLiquidity',
          args: [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }],
        });
        const collectData = encodeFunctionData({
          abi: npm.abi,
          functionName: 'collect',
          args: [{ tokenId, recipient: address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
        });

        setIsSimulating(true);
        // MANDATORY preflight - catches not-owner / wrong tokenId / already-empty before signing.
        const { request } = await publicClient.simulateContract({
          account: address,
          address: npm.address,
          abi: npm.abi,
          functionName: 'multicall',
          args: [[decreaseData, collectData]],
        });
        setIsSimulating(false);
        // Apply the Arc 20-gwei gas floor so the withdraw write is never under-priced (see lib/chain).
        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading('Withdrawing liquidity + fees', { id, description: arcScanTxUrl(tx) });
        bumpPollAfterWrite();
        void qc.refetchQueries({ type: 'active' });

        // IMPERATIVE receipt wait - resolves the keyed loading toast even though this row UNMOUNTS the
        // moment the position disappears from useOwnedPositions (the reactive useTxToast would never
        // fire after unmount, leaving the sonner spinner orphaned forever - the live bug). This async
        // fn keeps running post-unmount, so the toast is always settled to success / reverted / timeout.
        setIsConfirming(true);
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: tx,
            timeout: TX_RECEIPT_TIMEOUT_MS,
          });
          if (receipt.status === 'reverted') {
            toast.error('Remove liquidity reverted', { id });
          } else {
            setIsSuccess(true);
            toast.success('Liquidity + fees sent to your wallet', { id });
          }
        } catch {
          // Receipt timed out / RPC stalled - the withdraw may well have CONFIRMED (Arc can be slow to
          // return receipts). Replace the loading spinner with a reassuring, NON-STUCK toast rather than
          // claiming failure; the background poll surfaces the freed tokens shortly.
          toast.error('Sent - couldn’t confirm yet; your liquidity will update shortly (or refresh).', {
            id,
          });
        } finally {
          setIsConfirming(false);
          // Refetch once the receipt settles (success or timeout) so balances/positions update without
          // a manual refresh - mirrors the success/timeout refetch the shared useTxToast did.
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

  return { remove, isPending: isSimulating || isWriting || isConfirming, isSuccess, error, hash };
}
