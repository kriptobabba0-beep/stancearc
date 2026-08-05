// lib/embedded/connector.ts - a wagmi connector that exposes the embedded (Circle) wallet to the WHOLE
// app. Reads (balances, address, gating) and writes (approve/swap/mint/…) then work through the same
// wagmi APIs every page already uses (useAccount, useReadContract, writeContractAsync) - no per-component
// changes - while MetaMask stays on its own injected connector.
//
// How it works: an EIP-1193 provider whose `request` serves the embedded account + chain locally,
// forwards all reads to the Arc RPC, and routes `eth_sendTransaction` to Circle's contractExecution
// (signed by the user's PIN), resolving the real on-chain tx hash so viem's receipt wait works unchanged.
// The React (Circle) layer populates `embeddedBridge` so this module-level provider can reach the session.

import { createConnector } from 'wagmi';
import { getAddress } from 'viem';
import { arcTestnet } from '@/lib/chain';
import { ENV } from '@/lib/env';

type Hex = `0x${string}`;
export type EmbeddedSendTx = (tx: { to: Hex; data?: Hex; value?: bigint }) => Promise<Hex>;

/** Populated by the React layer (EmbeddedWalletConnector) so the provider can serve the account + sign. */
export const embeddedBridge: { address?: Hex; sendTransaction?: EmbeddedSendTx } = {};

export const EMBEDDED_CONNECTOR_ID = 'circleEmbedded';
const ARC_CHAIN_HEX: Hex = `0x${arcTestnet.id.toString(16)}`;

let rpcId = 1;
async function rpcForward(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(ENV.RPC_HTTP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || 'RPC request failed');
  return json.result;
}

type Listener = (...args: unknown[]) => void;

/** A minimal EIP-1193 provider backed by the embedded bridge + the Arc RPC. Exported for unit tests. */
export function createEmbeddedProvider() {
  const listeners: Record<string, Set<Listener>> = {};
  return {
    async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
      switch (method) {
        case 'eth_chainId':
          return ARC_CHAIN_HEX;
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return embeddedBridge.address ? [embeddedBridge.address] : [];
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null; // single-chain embedded wallet - treat as success
        case 'eth_sendTransaction': {
          const tx = (params as Array<{ to?: string; data?: string; value?: string }>)[0] ?? {};
          if (!embeddedBridge.sendTransaction) throw new Error('Embedded wallet is not ready.');
          if (!tx.to) throw new Error('Transaction is missing a target address.');
          const value = tx.value ? BigInt(tx.value) : 0n;
          return embeddedBridge.sendTransaction({ to: getAddress(tx.to), data: tx.data as Hex | undefined, value });
        }
        // The embedded (Circle MPC) wallet executes contract calls, but cannot produce a raw EIP-712 /
        // personal signature - without a case here these fall through to the Arc RPC, which has no key and
        // returns a cryptic "Method not found". The Gateway/CCTP bridges sign a burn intent, so tell the
        // user plainly to use a self-custody wallet rather than letting an unsignable request limp onward.
        case 'eth_signTypedData_v4':
        case 'eth_signTypedData':
        case 'eth_sign':
        case 'personal_sign':
          throw new Error(
            'The built-in wallet can’t sign bridge transfers. Connect a self-custody wallet (e.g. MetaMask) to use the bridges.',
          );
        default:
          return rpcForward(method, params as unknown[]);
      }
    },
    on(event: string, listener: Listener) {
      (listeners[event] ??= new Set()).add(listener);
    },
    removeListener(event: string, listener: Listener) {
      listeners[event]?.delete(listener);
    },
  };
}

const provider = createEmbeddedProvider();

export function embeddedConnector() {
  return createConnector((config) => ({
    id: EMBEDDED_CONNECTOR_ID,
    name: 'Limen Finance Wallet',
    type: 'embedded',
    async connect(_params?: { chainId?: number; isReconnecting?: boolean }) {
      const address = embeddedBridge.address;
      if (!address) throw new Error('Embedded wallet is not ready.');
      return { accounts: [address] as readonly Hex[], chainId: arcTestnet.id };
    },
    async disconnect() {},
    async getAccounts() {
      return (embeddedBridge.address ? [embeddedBridge.address] : []) as readonly Hex[];
    },
    async getChainId() {
      return arcTestnet.id;
    },
    async getProvider() {
      return provider;
    },
    async isAuthorized() {
      return !!embeddedBridge.address;
    },
    onAccountsChanged(accounts: string[]) {
      if (accounts.length === 0) config.emitter.emit('disconnect');
      else config.emitter.emit('change', { accounts: accounts.map((a) => getAddress(a)) as readonly Hex[] });
    },
    onChainChanged() {},
    onDisconnect() {
      config.emitter.emit('disconnect');
    },
  }));
}
