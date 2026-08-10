'use client';

// hooks/useIsEmbeddedWallet.ts — true when the ACTIVE wagmi connector is the embedded (Circle) connector.
//
// This is the truthful signal for "submitted via Circle": when this connector is active, writes via
// wagmi's writeContractAsync route through the embedded provider's eth_sendTransaction →
// embeddedBridge.sendTransaction → circle.executeContract (Circle's /user/transactions/contractExecution).
// It reflects the REAL write path, independent of the persisted WalletMode choice — so the Circle badge
// is shown exactly when a Circle contractExecution actually happens.

import { useAccount } from 'wagmi';
import { EMBEDDED_CONNECTOR_ID } from '@/lib/embedded/connector';

export function useIsEmbeddedWallet(): boolean {
  const { connector } = useAccount();
  return connector?.id === EMBEDDED_CONNECTOR_ID;
}
