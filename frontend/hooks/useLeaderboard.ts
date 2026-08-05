'use client';

// hooks/useLeaderboard.ts - per-address aggregates for the ACTIVE market. Rows now come from
// /api/leaderboard (the server-side incremental event index): one JSON fetch per visitor
// instead of the old client-side FULL-HISTORY getLogs sweep (hundreds of RPC calls per page
// view - a real contributor to Arc's "request limit reached"). The pure `buildLeaderboard`
// aggregation is kept below for its unit tests and as the reference for the old semantics.
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import { useActiveMarket } from '@/components/MarketProvider';
import type { LeaderboardPayload } from '@/lib/leaderboardIndex';
import type { DecodedLog } from '@/hooks/useEpochHistory';

/** One ranked row: aggregates for a single address across all of the market's epochs. */
export interface LeaderboardRow {
  address: `0x${string}`;
  entered: number; // distinct epochs staked
  won: number; // distinct epochs with a positive claim
  claimedBase: bigint; // summed base-leg (WETH/WBTC) payout
  claimedUSDC: bigint; // summed USDC payout
}

const argOf = (log: DecodedLog, key: string): unknown =>
  log.args && !Array.isArray(log.args) ? (log.args as Record<string, unknown>)[key] : undefined;

interface Acc {
  address: `0x${string}`;
  enteredEpochs: Set<string>;
  wonEpochs: Set<string>;
  claimedBase: bigint;
  claimedUSDC: bigint;
}

/**
 * Aggregate Staked + Claimed logs into ranked rows, sorted by claimedUSDC desc (tie-break claimedBase).
 * Pure so it is unit-testable with mocked logs. A Claimed with zero payout does NOT count as a win.
 */
export function buildLeaderboard(
  staked: DecodedLog[],
  claimed: DecodedLog[],
): LeaderboardRow[] {
  const byAddr = new Map<string, Acc>();

  const ensure = (owner: `0x${string}`): Acc => {
    const key = owner.toLowerCase();
    let acc = byAddr.get(key);
    if (!acc) {
      acc = { address: owner, enteredEpochs: new Set(), wonEpochs: new Set(), claimedBase: 0n, claimedUSDC: 0n };
      byAddr.set(key, acc);
    }
    return acc;
  };

  for (const l of staked) {
    const owner = argOf(l, 'owner') as `0x${string}` | undefined;
    const epochId = argOf(l, 'epochId');
    if (!owner || epochId === undefined) continue;
    ensure(owner).enteredEpochs.add(String(epochId));
  }

  for (const l of claimed) {
    const owner = argOf(l, 'owner') as `0x${string}` | undefined;
    const epochId = argOf(l, 'epochId');
    if (!owner || epochId === undefined) continue;
    const payBase = (argOf(l, 'payWETH') as bigint) ?? 0n;
    const payUSDC = (argOf(l, 'payUSDC') as bigint) ?? 0n;
    const acc = ensure(owner);
    acc.claimedBase += payBase;
    acc.claimedUSDC += payUSDC;
    // A win = an actual positive payout in that epoch.
    if (payBase > 0n || payUSDC > 0n) {
      acc.wonEpochs.add(String(epochId));
      acc.enteredEpochs.add(String(epochId)); // a claim implies entry even if the Staked log was missed
    }
  }

  return [...byAddr.values()]
    .map((a) => ({
      address: a.address,
      entered: a.enteredEpochs.size,
      won: a.wonEpochs.size,
      claimedBase: a.claimedBase,
      claimedUSDC: a.claimedUSDC,
    }))
    .sort((a, b) =>
      b.claimedUSDC === a.claimedUSDC
        ? b.claimedBase > a.claimedBase
          ? 1
          : b.claimedBase < a.claimedBase
            ? -1
            : 0
        : b.claimedUSDC > a.claimedUSDC
          ? 1
          : -1,
    );
}

/** react-query result for the active market's leaderboard (served by /api/leaderboard). */
export function useLeaderboard(): UseQueryResult<LeaderboardRow[], Error> {
  const market = useActiveMarket();
  const chainId = useChainId();

  return useQuery<LeaderboardRow[], Error>({
    queryKey: ['leaderboard', chainId, market.id],
    queryFn: async () => {
      const res = await fetch(`/api/leaderboard?market=${encodeURIComponent(market.id)}`);
      if (!res.ok) throw new Error(`leaderboard API ${res.status}`);
      const body = (await res.json()) as LeaderboardPayload;
      // Preserve the old ranking semantics for this table: total claimed, quote leg first.
      return body.rows
        .map((r) => ({
          address: r.address as `0x${string}`,
          entered: r.entered,
          won: r.won,
          claimedBase: BigInt(r.claimedBase),
          claimedUSDC: BigInt(r.claimedQuote),
        }))
        .sort((a, b) =>
          b.claimedUSDC === a.claimedUSDC
            ? b.claimedBase > a.claimedBase
              ? 1
              : b.claimedBase < a.claimedBase
                ? -1
                : 0
            : b.claimedUSDC > a.claimedUSDC
              ? 1
              : -1,
        );
    },
    staleTime: 30_000,
    retry: 1,
  });
}
