// hooks/useSwap.ts - swap one pool token for the other on the ACTIVE market's Uniswap-V3-fork pool via
// the shared SwapRouter.exactInputSingle. This is the trading-fee on-ramp: every swap pays the pool's
// 0.3% fee, which is what the LP positions earn and (when staked) what fills the Arena pots. Without a
// swap UI the pools never accrue fees - this hook is what actually generates them.
//
// The router PULLS the input token via transferFrom (exactly like the keeper's arb swaps), so the flow
// is up to TWO txs (mirrors useStakeWithConviction's approve-then-act with an allowance short-circuit):
//   1. APPROVE - if ERC20 allowance(user, router) < amountIn, approve(router, MAX) ONCE and AWAIT its
//      receipt (the swap's transferFrom needs the allowance live before it runs). MAX so the user is
//      approved for all future swaps after the first - the allowance short-circuit then skips re-approval.
//   2. SWAP   - simulate exactInputSingle({ tokenIn, tokenOut, fee: FEE_TIER, recipient: user,
//      deadline: now+20min, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0 }) → withGasFloor →
//      writeContractAsync → toast.loading → IMPERATIVELY await the receipt.
//
// WHY THE RECEIPT WAIT IS IMPERATIVE (mirrors useRemoveLiquidity, not the reactive useTxToast): the
// SwapForm refetches balances on success, and the form can re-render / the amount input can clear the
// moment a balance changes. An in-flight async fn keeps running regardless, so we resolve the keyed
// loading→success/reverted/timeout toast IMPERATIVELY inside `swap` via
// publicClient.waitForTransactionReceipt - it always settles even if the component re-renders. The
// approve step is awaited the same way so step 2 only runs once the allowance is on-chain.
import { useCallback, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { erc20Abi, maxUint256 } from 'viem';
import { swapRouter } from '@/lib/contracts';
import { ENV } from '@/lib/env';
import { ARC_CHAIN_ID, arcTestnet, withGasFloor } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { TX_RECEIPT_TIMEOUT_MS } from '@/hooks/useTxToast';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

const TOAST_ID = 'swap';
// 20-minute deadline from submit - generous for testnet block times; never the cause of a revert.
const DEADLINE_BUFFER_SECONDS = 20n * 60n;

export interface SwapArgs {
  /** The token being sold (its raw `amountIn` is pulled by the router). */
  tokenIn: `0x${string}`;
  /** The token being bought (credited to the user). */
  tokenOut: `0x${string}`;
  /** Exact input amount in `tokenIn` raw units. */
  amountIn: bigint;
  /** Minimum acceptable output (raw units of `tokenOut`) - slippage floor; the swap reverts below it. */
  amountOutMinimum: bigint;
}

export function useSwap() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  const { writeContractAsync, data: hash, isPending: isWriting } = useArcWriteContract();
  const [error, setError] = useState<Error | undefined>();
  const [isSimulating, setIsSimulating] = useState(false);
  // Imperative receipt-wait state (we do NOT use the reactive useTxReceipt here - see header).
  const [isApproving, setIsApproving] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const swap = useCallback(
    async ({ tokenIn, tokenOut, amountIn, amountOutMinimum }: SwapArgs) => {
      setError(undefined);
      setIsSuccess(false);
      try {
        if (!address) throw new Error('Connect your wallet first.');
        if (!publicClient) throw new Error('No RPC client available.');
        if (amountIn <= 0n) throw new Error('Enter an amount to swap.');

        // STEP 1 - APPROVE the router to pull `tokenIn` (only if the live allowance can't cover amountIn).
        // The router does transferFrom(user → router), so it needs an allowance ≥ amountIn before the swap.
        const currentAllowance = (await publicClient.readContract({
          address: tokenIn,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, swapRouter.address],
        })) as bigint;

        if (currentAllowance < amountIn) {
          setIsSimulating(true);
          const { request: approveReq } = await publicClient.simulateContract({
            account: address,
            address: tokenIn,
            abi: erc20Abi,
            functionName: 'approve',
            // MAX approval: one grant per token covers all future swaps (the allowance >= amountIn
            // short-circuit above then skips re-approval until the user manually revokes).
            args: [swapRouter.address, maxUint256],
          });
          setIsSimulating(false);
          const approveTx = await writeContractAsync(
            withGasFloor(approveReq) as Parameters<typeof writeContractAsync>[0],
          );
          toast.loading('Approving token for the swap', { id: TOAST_ID, description: arcScanTxUrl(approveTx) });
          // AWAIT the approve before swapping - the swap's transferFrom needs the allowance live on-chain.
          setIsApproving(true);
          try {
            await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: TX_RECEIPT_TIMEOUT_MS });
          } finally {
            setIsApproving(false);
          }
        }

        // STEP 2 - SWAP via exactInputSingle. Full-range single pool, so no price limit (0 = unbounded);
        // amountOutMinimum is the slippage floor that protects the user on-chain.
        const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_BUFFER_SECONDS;
        const params = {
          tokenIn,
          tokenOut,
          fee: ENV.FEE_TIER,
          recipient: address,
          deadline,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        } as const;

        setIsSimulating(true);
        // MANDATORY preflight - catches insufficient balance / allowance / slippage before signing.
        const { request } = await publicClient.simulateContract({
          account: address,
          address: swapRouter.address,
          abi: swapRouter.abi,
          functionName: 'exactInputSingle',
          args: [params],
        });
        setIsSimulating(false);
        // Apply the Arc 20-gwei gas floor so the swap write is never under-priced (see lib/chain).
        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading('Swapping', { id: TOAST_ID, description: arcScanTxUrl(tx) });
        bumpPollAfterWrite();
        void qc.refetchQueries({ type: 'active' });

        // IMPERATIVE receipt wait - settles the keyed loading toast to success / reverted / timeout even
        // if the form re-renders when a balance changes (the reactive useTxToast could miss it).
        setIsSwapping(true);
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: tx,
            timeout: TX_RECEIPT_TIMEOUT_MS,
          });
          if (receipt.status === 'reverted') {
            toast.error('Swap reverted', { id: TOAST_ID });
          } else {
            setIsSuccess(true);
            toast.success('Swapped', { id: TOAST_ID });
          }
        } catch {
          // Receipt timed out / RPC stalled - the swap may well have CONFIRMED (Arc can be slow to
          // return receipts). Replace the spinner with a reassuring, non-stuck toast; the poll surfaces
          // the new balances shortly.
          toast.error('Sent - couldn’t confirm yet; your balances will update shortly (or refresh).', {
            id: TOAST_ID,
          });
        } finally {
          setIsSwapping(false);
          // Refetch once the receipt settles (success or timeout) so balances update without a refresh.
          void qc.refetchQueries({ type: 'active' });
        }
        return tx;
      } catch (e) {
        setIsSimulating(false);
        setIsApproving(false);
        setIsSwapping(false);
        const err = new Error(friendlyError(e));
        setError(err);
        toast.error(err.message, { id: TOAST_ID });
        throw err;
      }
    },
    [address, publicClient, writeContractAsync, qc],
  );

  return {
    swap,
    isPending: isSimulating || isWriting || isApproving || isSwapping,
    isApproving,
    isSwapping,
    isSuccess,
    error,
    hash,
  };
}
