// hooks/useWithdrawCredited.ts — FeeArena **v2** deferred-payout recovery.
//
// v2 payouts (claim / refundConviction) are blocklist-resilient: when a direct USDC/WETH send to the
// owner FAILS (e.g. a Circle-blocklisted address), the arena CREDITS owedUSDC[owner] / owedWETH[owner]
// and emits PayoutDeferred instead of reverting. `withdrawCredited(to)` lets the caller pull that
// credited balance to a CLEAN address `to`. This hook:
//   - reads the connected wallet's owedUSDC / owedWETH (the deferred balance to surface in the UI), and
//   - exposes withdraw({ to }) that calls withdrawCredited(to) (default to = connected wallet).
// Reverts on-chain with NothingCredited when both ledgers are zero, ZeroAddress when to == 0 — the UI
// gates the button on hasCredit so the user never hits NothingCredited.
//
// v2-ONLY: the v1 arena has no owed* ledger / withdrawCredited. Callers must only use this for v2.
//
// WHY THE RECEIPT WAIT IS IMPERATIVE (not the shared reactive useTxToast/useTxReceipt): this hook is
// instantiated inside DeferredPayoutBanner, which returns null when !hasCredit. A successful
// withdrawCredited zeroes the owed* ledger → hasCredit flips false → the banner UNMOUNTS, usually
// BEFORE the receipt resolves. A reactive useTxToast/useTxReceipt unmounts with the banner and never
// fires, orphaning the keyed loading toast forever (sonner loading toasts never auto-dismiss). An
// in-flight async fn keeps running after its component unmounts, so we resolve the
// loading→success/reverted/timeout toast IMPERATIVELY inside `withdraw` via
// publicClient.waitForTransactionReceipt — that always settles the toast even once the banner is gone.
import { useCallback, useState } from 'react';
import { useAccount, usePublicClient, useReadContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { useMarketContracts } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV2Market } from '@/lib/markets';
import { ARC_CHAIN_ID, arcTestnet, withGasFloor } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite, usePollInterval } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { TX_RECEIPT_TIMEOUT_MS } from '@/hooks/useTxToast';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

const TOAST_ID = 'withdraw-credited';

export interface WithdrawCreditedArgs {
  /** Clean address to receive the credited USDC/WETH. Defaults to the connected wallet. */
  to?: `0x${string}`;
}

export function useWithdrawCredited() {
  const { feeArena } = useMarketContracts();
  const market = useActiveMarket();
  const v2 = isV2Market(market);
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  const interval = usePollInterval();
  const { writeContractAsync, data: hash, isPending: isWriting } = useArcWriteContract();
  const [error, setError] = useState<Error | undefined>();
  const [isSimulating, setIsSimulating] = useState(false);
  // The imperative receipt-wait state (we do NOT use the reactive useTxReceipt here — see header).
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // The connected wallet's deferred (credited) balances. Only meaningful for v2.
  const owedUSDCQuery = useReadContract({
    ...feeArena,
    functionName: 'owedUSDC',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: v2 && !!address, refetchInterval: interval },
  });
  const owedWETHQuery = useReadContract({
    ...feeArena,
    functionName: 'owedWETH',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: v2 && !!address, refetchInterval: interval },
  });

  const owedUSDC = (owedUSDCQuery.data as bigint | undefined) ?? 0n;
  const owedWETH = (owedWETHQuery.data as bigint | undefined) ?? 0n;
  const hasCredit = owedUSDC > 0n || owedWETH > 0n;

  const withdraw = useCallback(
    async ({ to }: WithdrawCreditedArgs = {}) => {
      setError(undefined);
      setIsSuccess(false);
      try {
        if (!publicClient) throw new Error('No RPC client available.');
        const dest = to ?? address;
        if (!dest) throw new Error('Connect your wallet first.');
        setIsSimulating(true);
        const { request } = await publicClient.simulateContract({
          account: address,
          address: feeArena.address,
          abi: feeArena.abi,
          functionName: 'withdrawCredited',
          args: [dest],
        });
        setIsSimulating(false);
        // Apply the Arc 20-gwei gas floor so the withdraw write is never under-priced (see lib/chain).
        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading('Withdrawing credited balance', { id: TOAST_ID, description: arcScanTxUrl(tx) });
        bumpPollAfterWrite();
        void qc.refetchQueries({ type: 'active' });

        // IMPERATIVE receipt wait — resolves the keyed loading toast even though the DeferredPayoutBanner
        // UNMOUNTS the moment the owed* ledger zeroes (hasCredit → false). The reactive useTxToast would
        // never fire after unmount, leaving the sonner spinner orphaned forever — the bug. This async fn
        // keeps running post-unmount, so the toast is always settled to success / reverted / timeout.
        setIsConfirming(true);
        try {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: tx,
            timeout: TX_RECEIPT_TIMEOUT_MS,
          });
          if (receipt.status === 'reverted') {
            toast.error('Withdraw reverted', { id: TOAST_ID });
          } else {
            setIsSuccess(true);
            toast.success('Withdrew credited balance', { id: TOAST_ID });
          }
        } catch {
          // Receipt timed out / RPC stalled — the withdraw may well have CONFIRMED (Arc can be slow to
          // return receipts). Replace the loading spinner with a reassuring, NON-STUCK toast rather than
          // claiming failure; the background poll surfaces the updated balance shortly.
          toast.error('Sent — couldn’t confirm yet; your balance will update shortly (or refresh).', {
            id: TOAST_ID,
          });
        } finally {
          setIsConfirming(false);
          // Refetch once the receipt settles (success or timeout) so the owed* balance updates without a
          // manual refresh — mirrors the success/timeout refetch the shared useTxToast did.
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

  return {
    withdraw,
    owedUSDC,
    owedWETH,
    hasCredit,
    isPending: isSimulating || isWriting || isConfirming,
    isSuccess,
    error,
    hash,
  };
}
