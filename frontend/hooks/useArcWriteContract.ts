'use client';

// hooks/useArcWriteContract.ts — useWriteContract for the Arc-only surfaces: it puts the wallet on
// Arc before it signs anything.
//
// Pinning the chain (see withGasFloor) already made a wrong-network write IMPOSSIBLE — viem throws
// instead of signing. This closes the other half: without it the user is simply stopped, has to
// notice the banner, switch by hand, and start over. Here the click that starts a write is also the
// click that fixes the network.
//
// If the wallet has never heard of Arc, wagmi's injected connector handles that too: its switchChain
// falls back to `wallet_addEthereumChain` on error 4902, built from our chain definition — name,
// rpc url, block explorer and native currency are all already there. So "switch" covers "add".
//
// Deliberately NOT used by the bridge and gateway surfaces. Those move the wallet to CCTP source
// chains on purpose, and forcing Arc there would break the very flow they implement.
import { useCallback } from 'react';
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi';
import { ARC_CHAIN_ID } from '@/lib/chain';

/** How long wagmi is given to notice the wallet's new chain before the write is tried again. */
const CHAIN_SETTLE_MS = 400;

/**
 * wagmi's own complaint that its cached connection chain disagrees with the connector's real one.
 * Matched by name and text because the class is not exported from the package's public surface.
 */
export function isConnectorChainMismatch(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return /ConnectorChainMismatch|current chain of the connector .* does not match/i.test(text);
}

/**
 * Puts the wallet on Arc, switching (or adding) only when it isn't already.
 *
 * The chain is read from the CONNECTOR, not from `useChainId()`. wagmi's `getChainId(config)`
 * returns `config.state.chainId`, a cached value, while viem validates the write against a live
 * `eth_chainId` straight from the provider. MetaMask now keeps a network per site, so those two
 * genuinely disagree: the cache said Arc, this guard skipped the switch, and the write then failed
 * the assertion with "wrong network" for someone whose wallet really was on Arc. Asking the
 * provider means the guard sees what viem will see.
 */
export function useEnsureArcChain(): () => Promise<void> {
  const { connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  return useCallback(async () => {
    if (!connector) return; // not connected — the write's own guard reports that far better
    let current: number | undefined;
    try {
      current = await connector.getChainId();
    } catch {
      // Unreadable: fall through and let the switch decide rather than guessing it is fine.
    }
    if (current === ARC_CHAIN_ID) return;
    await switchChainAsync({ chainId: ARC_CHAIN_ID });
  }, [connector, switchChainAsync]);
}

/**
 * `useWriteContract` with the network handled. Same shape, so call sites only swap the hook name.
 *
 * Rejecting the switch throws UserRejectedRequestError, which the existing error copy already reads
 * as "Transaction rejected in wallet." — the write never runs, which is the point.
 */
export function useArcWriteContract() {
  const base = useWriteContract();
  const ensureArcChain = useEnsureArcChain();
  const { writeContractAsync } = base;

  // wagmi types writeContractAsync generically over the ABI, and TypeScript cannot carry generics
  // through a wrapper. The cast is the standard way around that and is honest here: the arguments
  // are forwarded untouched and the return value is passed straight back — the only difference is
  // an awaited network check before the call.
  type WriteAsync = typeof writeContractAsync;
  const guarded = useCallback(
    ((...args: unknown[]) => {
      const send = writeContractAsync as unknown as (...a: unknown[]) => ReturnType<WriteAsync>;
      return ensureArcChain()
        .then(() => send(...args))
        .catch(async (err: unknown) => {
          if (!isConnectorChainMismatch(err)) throw err;
          // wagmi keeps the connection's chain in its own state and updates it from the wallet's
          // chainChanged event. Immediately after a switch — especially the add-then-switch a wallet
          // that has never seen Arc goes through — that cache can still hold the old id, and wagmi
          // refuses the write by comparing its stale value against the connector's real one. The
          // wallet is already right; it just has to catch up.
          //
          // Retrying is safe: this throws inside getConnectorClient, BEFORE any client is built or
          // anything is sent, so there is no transaction in flight to duplicate.
          await new Promise((r) => setTimeout(r, CHAIN_SETTLE_MS));
          return send(...args);
        });
    }) as unknown as WriteAsync,
    [ensureArcChain, writeContractAsync],
  );

  return { ...base, writeContractAsync: guarded };
}
