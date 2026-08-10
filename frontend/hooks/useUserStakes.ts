// hooks/useUserStakes.ts — the connected wallet's staked positions for "Your positions".
//
// VERSION-AWARE:
//   - v1: the arena exposes getUserStakes(addr) -> StakeView[] directly. Used verbatim.
//   - v2: the arena has NO getUserStakes, and the Lens has none either — the only per-account read is
//     Lens.getStakesByEpoch(epochId) (ALL stakes in an epoch), filtered client-side by owner. Because
//     claims/unstakes span SETTLED past epochs, we read a WINDOW of recent epochs
//     [currentEpochId .. currentEpochId-(N-1)] via one multicall, flatten, and keep the caller's rows.
//
// Either way the return shape is StakeView[] so ClaimUnstakePanel / useOwnedPositions are unchanged.
import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { useMarketContracts } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV2Market, isV3Market } from '@/lib/markets';
import { arcTestnet } from '@/lib/chain';
import type { StakeView } from '@/lib/types';
import { adaptStakeV3, dedupeStakesByTokenId, type RawStakeV3 } from '@/lib/epochV3';
import { usePollInterval } from '@/hooks/usePollInterval';

// How many recent epochs back from the current one to scan for a user's positions in v2. A v2 epoch is
// short-lived; pending claims/unstakes live in the last few settled epochs. 8 comfortably covers the
// settle + claim window without an unbounded historical scan.
export const V2_STAKE_LOOKBACK_EPOCHS = 8;

/** Build the descending epochId window [current .. current-(lookback-1)], clamped at 0 (epochs are 1-based). */
export function recentEpochIds(currentEpochId: bigint, lookback: number): bigint[] {
  const ids: bigint[] = [];
  for (let i = 0; i < lookback; i++) {
    const id = currentEpochId - BigInt(i);
    if (id < 1n) break; // epoch ids are 1-based; never query 0 / negatives
    ids.push(id);
  }
  return ids;
}

export function useUserStakes(address?: `0x${string}`) {
  const contracts = useMarketContracts();
  const market = useActiveMarket();
  const v2 = isV2Market(market);
  const v3 = isV3Market(market);
  const interval = usePollInterval();

  // ── v1/v3 path: arena.getUserStakes(addr) (v3 rows are adapted below) ─────────────────
  const v1Query = useReadContract({
    ...contracts.feeArena,
    functionName: 'getUserStakes',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: !v2 && !!address, refetchInterval: interval },
  });

  // ── v2 path: Lens.getStakesByEpoch over a recent-epoch window, filtered by owner ──────
  // 1) currentEpochId() off the arena — the top of the scan window.
  const epochIdQuery = useReadContract({
    ...contracts.feeArena,
    functionName: 'currentEpochId',
    chainId: arcTestnet.id,
    query: { enabled: v2 && !!address, refetchInterval: interval },
  });
  const currentEpochId = epochIdQuery.data as bigint | undefined;

  // 2) one multicall of Lens.getStakesByEpoch(id) for each id in the window.
  const epochIds = useMemo(
    () => (v2 && currentEpochId !== undefined ? recentEpochIds(currentEpochId, V2_STAKE_LOOKBACK_EPOCHS) : []),
    [v2, currentEpochId],
  );
  const lens = contracts.lens;
  const stakeCalls = useMemo(
    () =>
      lens && epochIds.length > 0
        ? epochIds.map((id) => ({
            address: lens.address,
            abi: lens.abi,
            functionName: 'getStakesByEpoch' as const,
            args: [id] as const,
            chainId: arcTestnet.id,
          }))
        : [],
    [lens, epochIds],
  );
  const stakesQuery = useReadContracts({
    contracts: stakeCalls,
    query: { enabled: v2 && !!address && stakeCalls.length > 0, refetchInterval: interval },
  });

  // 3) flatten the per-epoch StakeView[] results and keep only the connected owner's rows.
  const v2Data = useMemo<readonly StakeView[] | undefined>(() => {
    if (!v2 || !address) return undefined;
    if (!stakesQuery.data) return undefined;
    const owner = address.toLowerCase();
    const out: StakeView[] = [];
    for (const res of stakesQuery.data) {
      if (res.status !== 'success' || !res.result) continue;
      for (const s of res.result as readonly StakeView[]) {
        if (s.owner.toLowerCase() === owner) out.push(s);
      }
    }
    return out;
  }, [v2, address, stakesQuery.data]);

  // v3 rows arrive in the v3 StakeView shape (entryPrice18/processed/won) — normalize them
  // onto the app-wide StakeView (+ keep the entry-anchor extras on `.v3`).
  const v3Data = useMemo<readonly StakeView[] | undefined>(() => {
    if (!v3 || !v1Query.data) return undefined;
    // getUserStakes lists a tokenId once per epoch it was EVER staked in (append-only
    // userEpochTokenIds); all copies resolve to the same current positions[tokenId], so
    // collapse to one row per tokenId — otherwise a re-staked NFT renders multiple times.
    return dedupeStakesByTokenId((v1Query.data as readonly RawStakeV3[]).map(adaptStakeV3));
  }, [v3, v1Query.data]);

  if (v2) {
    const isLoading = !!address && (epochIdQuery.isLoading || (stakeCalls.length > 0 && stakesQuery.isLoading));
    const isError = epochIdQuery.isError || stakesQuery.isError;
    return {
      ...stakesQuery,
      data: v2Data,
      isLoading,
      isError,
    } as unknown as ReturnType<typeof useReadContract> & { data: readonly StakeView[] | undefined };
  }

  if (v3) {
    return { ...v1Query, data: v3Data } as unknown as ReturnType<typeof useReadContract> & {
      data: readonly StakeView[] | undefined;
    };
  }

  return v1Query as ReturnType<typeof useReadContract> & { data: readonly StakeView[] | undefined };
}
