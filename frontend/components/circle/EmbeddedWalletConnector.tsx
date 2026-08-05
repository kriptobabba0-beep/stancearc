'use client';

// components/circle/EmbeddedWalletConnector.tsx - bridges the embedded (Circle) wallet into wagmi so the
// whole app (Swap, Pools, Arena, balances, gating) works with it like any other wallet.
//   • Populates embeddedBridge with the address + a sign function (executeContract → on-chain tx hash).
//   • Connects/disconnects the wagmi 'circleEmbedded' connector as the embedded session comes and goes.
// MetaMask keeps using the injected connector; this never overrides an active injected connection.

import { useCallback, useEffect, useRef } from 'react';
import { formatUnits } from 'viem';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { useCircleWallet } from '@/components/circle/CircleWalletProvider';
import { embeddedBridge, EMBEDDED_CONNECTOR_ID, type EmbeddedSendTx } from '@/lib/embedded/connector';

export function EmbeddedWalletConnector() {
  const { isReady, address, executeContract, fetchTransactions } = useCircleWallet();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const account = useAccount();
  const connectingRef = useRef(false);

  // Sign a transaction with the embedded wallet: run Circle's contractExecution (the user approves with
  // their PIN), then resolve the real on-chain hash by watching the wallet's tx feed for the new entry.
  const sendTransaction = useCallback<EmbeddedSendTx>(
    async ({ to, data, value }) => {
      // Native value (e.g. the ~1-wei Pyth update fee on a payable v3 stakeWithSide) → Circle's
      // contractExecution `amount`, which is a DECIMAL whole-token string. Arc's native token is 18dp,
      // so convert wei → tokens. (A payable stake refunds any excess msg.value on-chain.)
      const amount = value && value > 0n ? formatUnits(value, 18) : undefined;
      const before = new Set((await fetchTransactions().catch(() => [])).map((t) => t.id));
      await executeContract({ contractAddress: to, callData: data ?? '0x', ...(amount !== undefined ? { amount } : {}) });
      for (let i = 0; i < 24; i++) {
        const txs = await fetchTransactions().catch(() => []);
        const fresh = txs.find((t) => !before.has(t.id) && t.txHash);
        if (fresh?.txHash) return fresh.txHash as `0x${string}`;
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error('Timed out waiting for the transaction to be mined. Check My Wallet or ArcScan.');
    },
    [executeContract, fetchTransactions],
  );

  // Keep the bridge in sync so the connector's provider can serve the account + sign.
  useEffect(() => {
    embeddedBridge.address = isReady && address ? address : undefined;
    embeddedBridge.sendTransaction = sendTransaction;
  }, [isReady, address, sendTransaction]);

  // Connect / disconnect the wagmi embedded connector in step with the embedded session.
  useEffect(() => {
    const embedded = connectors.find((c) => c.id === EMBEDDED_CONNECTOR_ID);
    if (!embedded) return;
    if (isReady && address) {
      // Only auto-connect when nothing else is connected - never hijack an active MetaMask session.
      if (account.connector?.id !== EMBEDDED_CONNECTOR_ID && account.status === 'disconnected' && !connectingRef.current) {
        connectingRef.current = true;
        connect({ connector: embedded }, { onSettled: () => (connectingRef.current = false) });
      }
    } else if (account.connector?.id === EMBEDDED_CONNECTOR_ID) {
      disconnect({ connector: account.connector });
    }
  }, [isReady, address, account.connector, account.status, connect, disconnect, connectors]);

  return null;
}
