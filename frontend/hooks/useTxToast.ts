// hooks/useTxToast.ts - centralized tx-lifecycle toast driver shared by every write hook. The 7 write
// hooks all follow the same shape: submit a tx (writeContractAsync returns a hash AT SUBMIT), fire a
// keyed `toast.loading(...)`, then wait on `useWaitForTransactionReceipt({ hash })`. Previously each
// hook only handled the `isSuccess` branch - so a tx that MINED-BUT-REVERTED still showed a green
// success toast (the receipt resolves with isSuccess=true even when `status === 'reverted'`), and a
// receipt query that ERRORED/TIMED-OUT left the keyed loading spinner orphaned forever (sonner loading
// toasts have no auto-dismiss).
//
// This hook centralizes the loading→(success | reverted | error/timeout) terminal handling + the
// refetch-on-success so the behavior is consistent and can't drift between hooks. Each write hook keeps
// its own wording (passed via `labels`) and still fires the submit-time `toast.loading(...)` itself
// (so the ArcScan tx link is attached at submit). This hook reacts to the RECEIPT and replaces that
// keyed loading toast with exactly one definitive terminal toast per hash.
import { useEffect, useRef } from 'react';
import { useWaitForTransactionReceipt } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast } from '@/lib/toast';

/** Default timeout (ms) applied to the receipt query so it can't hang forever on a dropped tx / RPC stall. */
export const TX_RECEIPT_TIMEOUT_MS = 120_000;

/**
 * useTxReceipt - the SHARED receipt-wait wrapper every write flow uses INSTEAD of calling wagmi's
 * `useWaitForTransactionReceipt` directly. It exists to fix a LIVE wedge:
 *
 * ROOT CAUSE of the "Providing liquidity…" spinner sticking forever even though the mint CONFIRMED:
 *   - viem's `waitForTransactionReceipt` REJECTS on `timeout` (and after `retryCount` blocks). Good.
 *   - BUT the receipt wait runs as a react-query query, and the app's global QueryClient default is
 *     `retry: 2` (see lib/queryClient.ts). So when Arc's RPC is slow to return `eth_getTransactionReceipt`
 *     and the first 120s timeout rejects, react-query RE-RAN the query twice more - each restarting the
 *     full 120s viem timeout. So `isError` only flipped true after ~3×120s ≈ 6 minutes (plus backoff),
 *     which is "forever" to a user. The receipt-arrives + isError-clears logic downstream was correct;
 *     it simply never fired in time.
 *
 * THE FIX (one place, fixes every flow): force `retry: false` on the receipt query so the FIRST timeout
 * / RPC error is the TERMINAL state - `isError` flips true after one ~120s window, the write hooks'
 * `useTxToast` error branch + the on-ramp panel's `awaitingReceipt` clear fire promptly, the button
 * re-enables and we surface "couldn't confirm - it'll appear shortly / refresh" instead of a dead
 * spinner. Retrying a *timeout* is pointless anyway (a confirmed-but-slow receipt is recovered by the
 * background positions poll, not by re-arming the wait). The finite `timeout` is also forwarded here so
 * callers don't each have to remember it.
 */
export function useTxReceipt(
  hash: `0x${string}` | undefined,
  options?: { chainId?: number; query?: { enabled?: boolean } },
) {
  return useWaitForTransactionReceipt({
    hash,
    chainId: options?.chainId,
    timeout: TX_RECEIPT_TIMEOUT_MS,
    query: {
      ...options?.query,
      // The terminal-state fix: never re-run a rejected receipt wait (a timeout won't resolve on retry,
      // and a successful-but-slow receipt is picked up by the post-write positions poll instead).
      retry: false,
    },
  });
}

/** Minimal shape of a viem receipt we care about - only the mined/reverted status. */
interface ReceiptLike {
  status?: 'success' | 'reverted';
}

export interface TxToastLabels {
  /** Toast on a mined+successful receipt (status === 'success'). */
  success: string;
  /** Toast on a mined+REVERTED receipt (status === 'reverted'). Defaults to a generic revert message. */
  reverted?: string;
  /** Toast when the receipt query errors/times out (never resolved). Defaults to a generic confirm-failure message. */
  error?: string;
}

export interface UseTxToastArgs {
  /** The keyed toast id (stable per action) - the loading toast is replaced in place. */
  id: string;
  /** The submitted tx hash (undefined until submit). */
  hash: `0x${string}` | undefined;
  /** The receipt query's `data` (viem TransactionReceipt) - carries `status`. */
  receipt: ReceiptLike | undefined;
  /** The receipt query's `isSuccess` (it resolved - but check `receipt.status` for revert). */
  isSuccess: boolean;
  /** The receipt query's `isError` (it errored / timed out and will never resolve). */
  isError: boolean;
  labels: TxToastLabels;
}

/**
 * Drives the keyed loading→terminal toast for one tx + refetches active queries on a genuine success.
 * Fires exactly ONE terminal toast per hash (guarded by a ref) so a re-render can't re-toast or
 * double-refetch. Resets the guard whenever the hash changes/clears so the next tx is handled fresh.
 */
export function useTxToast({ id, hash, receipt, isSuccess, isError, labels }: UseTxToastArgs): void {
  const qc = useQueryClient();
  // The hash we've already driven to a terminal toast - prevents re-firing on subsequent renders.
  const handledHash = useRef<`0x${string}` | undefined>(undefined);

  useEffect(() => {
    if (!hash) return;
    // Only act once per hash. Once a hash has been finalized (success/reverted/error) we never re-toast
    // it; a fresh submit produces a new hash, resetting this guard implicitly via the !== check.
    if (handledHash.current === hash) return;

    // Receipt arrived (resolved). Distinguish a genuine success from a mined-but-reverted tx.
    if (isSuccess && receipt) {
      handledHash.current = hash;
      if (receipt.status === 'reverted') {
        // Mined but reverted - NOT a success. Surface an error toast; do not claim success.
        toast.error(labels.reverted ?? 'Transaction reverted', { id });
      } else {
        bumpPollAfterWrite();
        toast.success(labels.success, { id });
        // Force an immediate refetch of all mounted queries on a genuine success so the UI updates
        // without a manual page refresh (mirrors the previous per-hook isSuccess refetch).
        void qc.refetchQueries({ type: 'active' });
      }
      return;
    }

    // Receipt query errored / timed out (dropped tx, RPC failure, timeout) - it will never resolve.
    // Replace the orphaned loading spinner with a definitive (non-stuck) toast. CRUCIALLY: the tx may
    // have actually CONFIRMED on-chain - a receipt timeout is most often just a slow Arc RPC, not a
    // failed tx (the original live wedge: NFT minted, receipt never returned). So we ALSO bump the poll
    // and force an immediate refetch here, exactly like the success path, so the new position/balance/
    // claim state surfaces shortly WITHOUT a manual page refresh. We never claim success (the label is
    // a reassuring "couldn't confirm yet - appears shortly / refresh"), but we don't leave the UI stale.
    if (isError) {
      handledHash.current = hash;
      toast.error(labels.error ?? 'Could not confirm transaction', { id });
      bumpPollAfterWrite();
      void qc.refetchQueries({ type: 'active' });
    }
  }, [hash, receipt, isSuccess, isError, id, labels.success, labels.reverted, labels.error, qc]);
}
