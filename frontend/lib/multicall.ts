// lib/multicall.ts — Multicall3 batching for per-position read fan-out (one eth_call).
// Canonical Multicall3 0xcA11bde05977b3631167028862bE2a173976CA11 (same address every chain).
import type { PublicClient, MulticallParameters, MulticallReturnType } from 'viem';
import { MULTICALL3_ADDRESS } from '@/lib/contracts';

/**
 * Batch many read calls into one eth_call via Multicall3. Returns per-call {status,result|error}.
 * `allowFailure: true` is pinned so a single reverting per-position read never drops the whole batch.
 * The `contracts` array drives viem's tuple inference (pass it `as const` at the call site for typed results).
 */
export async function batchReads<
  const contracts extends readonly unknown[],
>(
  client: PublicClient,
  calls: MulticallParameters<contracts, true>['contracts'],
): Promise<MulticallReturnType<contracts, true>> {
  return client.multicall({
    contracts: calls,
    multicallAddress: MULTICALL3_ADDRESS,
    allowFailure: true,
  });
}
