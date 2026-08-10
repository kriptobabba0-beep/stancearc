// lib/chain.ts — viem/wagmi Arc Testnet Chain definition (env-overridable; nothing mainnet-hardcoded).
import { defineChain } from 'viem';
import { ENV } from '@/lib/env';

export const ARC_CHAIN_ID = ENV.CHAIN_ID; // 5042002 (asserted in lib/env)

// Arc testnet min base fee floor (~20 Gwei). Write hooks MUST spread this as maxFeePerGas
// when submitting tx (wagmi v2 has no global write-fee override) so writes are never under-priced.
export const GAS_FLOOR_WEI = 20_000_000_000n; // 20 Gwei
// Tip paid to the proposer on top of the base fee (EIP-1559 maxPriorityFeePerGas). 1 Gwei is plenty
// on Arc testnet; pairing it with GAS_FLOOR_WEI keeps writes priced above the base-fee floor.
export const MAX_PRIORITY_FEE_WEI = 1_000_000_000n; // 1 Gwei

/**
 * ONE source of truth for the two things every Arc write must carry: the gas-floor and the CHAIN.
 *
 * The gas floor spreads the 20-gwei `maxFeePerGas` and the 1-gwei priority fee onto a simulated
 * `{ request }` so a write is never under-priced on Arc.
 *
 * `chainId` is here because leaving it off sent real transactions to whatever network the wallet
 * happened to be on. wagmi's `writeContract` destructures `chainId` from its parameters, resolves
 * the connector client with `parameters.chainId ?? connection.chainId`, and then calls viem with
 * `chain: chainId ? { id: chainId } : null` — and `chain: null` tells viem to SKIP the chain check
 * entirely. A viem `simulateContract` request carries `chain`, not `chainId`, so passing it through
 * left both the client and the assertion on the wallet's current network.
 *
 * On 2026-08-05 that put two `approve` calls on Ethereum MAINNET, addressed to Arc token contracts.
 * Those addresses hold no code on mainnet, and a call to a codeless address succeeds silently and
 * emits nothing — so it cost gas, produced a green transaction, and did nothing. Both simulations
 * passed for the same reason. With `chainId` set, viem asserts the wallet's chain and throws
 * instead of signing.
 *
 * An explicit `chainId` on the incoming request still wins, so the multi-chain bridge/gateway flows
 * (which target CCTP source chains on purpose) are unaffected — they never route through here.
 */
export function withGasFloor<T>(request: T): T & {
  chainId: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
} {
  return {
    ...request,
    chainId: (request as { chainId?: number })?.chainId ?? ARC_CHAIN_ID,
    maxFeePerGas: GAS_FLOOR_WEI,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_WEI,
  };
}

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  // NATIVE TOKEN IS GAS-ONLY. 18 decimals. Shown solely as a labeled "USDC (gas)" balance —
  // NEVER used in fee/contribution/payout math (that is the 6-dp ERC-20 USDC at 0x3600...).
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: {
      http: [ENV.RPC_HTTP],     // https://rpc.testnet.arc.network
      webSocket: [ENV.RPC_WS],  // wss://rpc.testnet.arc.network
    },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: ENV.EXPLORER_URL }, // https://testnet.arcscan.app
  },
  contracts: {
    // Canonical Multicall3 (same address every chain) — batches per-position reads.
    multicall3: { address: ENV.MULTICALL3_ADDRESS },
  },
  testnet: true,
});
