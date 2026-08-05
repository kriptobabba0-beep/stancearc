'use client';

// hooks/useArcWriteContract.ts - useWriteContract for the Arc-only surfaces: it puts the wallet on
// Arc before it signs anything.
//
// Pinning the chain (see withGasFloor) already made a wrong-network write IMPOSSIBLE - viem throws
// instead of signing. This closes the other half: without it the user is simply stopped, has to
// notice the banner, switch by hand, and start over. Here the click that starts a write is also the
// click that fixes the network.
//
// If the wallet has never heard of Arc, wagmi's injected connector handles that too: its switchChain
// falls back to `wallet_addEthereumChain` on error 4902, built from our chain definition - name,
// rpc url, block explorer and native currency are all already there. So "switch" covers "add".
//
// Deliberately NOT used by the bridge and gateway surfaces. Those move the wallet to CCTP source
// chains on purpose, and forcing Arc there would break the very flow they implement.
import { useCallback } from 'react';
import { useChainId, useSwitchChain, useWriteContract } from 'wagmi';
import { ARC_CHAIN_ID } from '@/lib/chain';

/**
 * Puts the wallet on Arc, switching (or adding) only when it isn't already.
 *
 * A stale `chainId` from the last render is safe in both directions: if it wrongly says "not Arc"
 * the switch is a no-op the wallet resolves immediately, and if it wrongly says "Arc" the write
 * still refuses to sign on the wrong chain. The guard can be early, never wrong.
 */
export function useEnsureArcChain(): () => Promise<void> {
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  return useCallback(async () => {
    if (chainId === ARC_CHAIN_ID) return;
    await switchChainAsync({ chainId: ARC_CHAIN_ID });
  }, [chainId, switchChainAsync]);
}

/**
 * `useWriteContract` with the network handled. Same shape, so call sites only swap the hook name.
 *
 * Rejecting the switch throws UserRejectedRequestError, which the existing error copy already reads
 * as "Transaction rejected in wallet." - the write never runs, which is the point.
 */
export function useArcWriteContract() {
  const base = useWriteContract();
  const ensureArcChain = useEnsureArcChain();
  const { writeContractAsync } = base;

  // wagmi types writeContractAsync generically over the ABI, and TypeScript cannot carry generics
  // through a wrapper. The cast is the standard way around that and is honest here: the arguments
  // are forwarded untouched and the return value is passed straight back - the only difference is
  // an awaited network check before the call.
  type WriteAsync = typeof writeContractAsync;
  const guarded = useCallback(
    ((...args: unknown[]) =>
      ensureArcChain().then(() =>
        (writeContractAsync as unknown as (...a: unknown[]) => ReturnType<WriteAsync>)(...args),
      )) as unknown as WriteAsync,
    [ensureArcChain, writeContractAsync],
  );

  return { ...base, writeContractAsync: guarded };
}
