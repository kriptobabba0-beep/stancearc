'use client';

// hooks/useEpochHistory.ts - past-epoch table for the ACTIVE market, built purely from FeeArena
// event logs (no backend indexer). Reads EpochStarted + EpochSettled + EmptyWinnerRollover via
// chunked getLogs from the market's deploy block, joins by epochId, and caches with react-query.
// Re-keyed by market id + chainId so switching market (or chain) refetches a fresh history.
// winnerCount for settled non-rollover rows is backfilled via a batched multicall to winnerCount(epochId).
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useChainId } from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import type { AbiEvent } from 'viem';
import { wagmiConfig } from '@/lib/wagmi';
import { arcTestnet } from '@/lib/chain';
import { feeArenaAbi, feeArenaV3Abi } from '@/abis';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV3Market } from '@/lib/markets';
import { getEventLogsChunked } from '@/lib/events';
import { batchReads } from '@/lib/multicall';
import { Side } from '@/lib/types';

/** One past-epoch row joined across start / settle / rollover events. */
export interface EpochHistoryRow {
  epochId: bigint;
  startPrice18: bigint;
  /** Settle price from EpochResolved (v1) or the single settlement price (v3). */
  settlePrice18?: bigint;
  /** Signed Δbps from EpochResolved (1e4 = 100%), when available (v1 only - v3 is per-position). */
  deltaBps?: bigint;
  winningSide: Side;
  potBase: bigint; // base-leg pot (WETH/WBTC/cirBTC) at the market's base decimals
  potUSDC: bigint;
  /** Distinct winners. v1: backfilled from winnerCount(epochId). v3: carried in EpochSettled. */
  winnerCount?: number;
  rolledOver: boolean;
  /**
   * ENTRY-ANCHORED (v3) row: there is NO global winning side - each position resolved against its
   * own entry price. The UI renders "per-position" + the count of correct positions instead of a
   * winning-side badge, and shows only the settlement price (no global start price).
   */
  perPosition?: boolean;
}

/** Pull the named event item out of a FeeArena ABI for typed, decoded getLogs. */
function eventAbiFrom(abi: readonly unknown[], name: string): AbiEvent {
  const item = (abi as { type: string; name?: string }[]).find((e) => e.type === 'event' && e.name === name);
  if (!item) throw new Error(`[useEpochHistory] FeeArena ABI missing event ${name}`);
  return item as AbiEvent;
}
const eventAbi = (name: string): AbiEvent => eventAbiFrom(feeArenaAbi, name);

const EPOCH_STARTED = eventAbi('EpochStarted');
const EPOCH_SETTLED = eventAbi('EpochSettled');
const EPOCH_RESOLVED = eventAbi('EpochResolved');
const EMPTY_WINNER_ROLLOVER = eventAbi('EmptyWinnerRollover');

// v3 (entry-anchored) event signatures differ from v1 (different topics), so they need their own
// AbiEvent items: EpochSettled(epochId,finalPrice18,winnerCount,potBase,potUSDC) +
// EmptyWinnerRollover(epochId,potBase,potUSDC).
const V3_EPOCH_SETTLED = eventAbiFrom(feeArenaV3Abi, 'EpochSettled');
const V3_EMPTY_WINNER_ROLLOVER = eventAbiFrom(feeArenaV3Abi, 'EmptyWinnerRollover');

// viem decodes named-arg events to a Record, but the static type is a union with the unnamed-tuple
// form; accept both and read by key only when it's the object form (all FeeArena events are named).
type LogArgs = Record<string, unknown> | readonly unknown[] | undefined;
export interface DecodedLog {
  args?: LogArgs;
}
const argOf = (log: DecodedLog, key: string): unknown =>
  log.args && !Array.isArray(log.args) ? (log.args as Record<string, unknown>)[key] : undefined;

/**
 * Join start + settle + resolved + rollover logs into per-epoch rows (newest epoch first).
 * Pure so it is unit-testable with mocked logs. `settle`/`resolved` are separate FeeArena events.
 */
export function buildEpochRows(
  started: DecodedLog[],
  settled: DecodedLog[],
  resolved: DecodedLog[],
  rollovers: DecodedLog[],
): EpochHistoryRow[] {
  const rows = new Map<string, EpochHistoryRow>();

  const ensure = (epochId: bigint): EpochHistoryRow => {
    const key = epochId.toString();
    let row = rows.get(key);
    if (!row) {
      row = { epochId, startPrice18: 0n, winningSide: Side.NONE, potBase: 0n, potUSDC: 0n, rolledOver: false };
      rows.set(key, row);
    }
    return row;
  };

  for (const l of started) {
    const id = argOf(l, 'epochId');
    if (id === undefined) continue;
    const row = ensure(BigInt(id as bigint));
    row.startPrice18 = (argOf(l, 'startPrice18') as bigint) ?? 0n;
  }

  for (const l of settled) {
    const id = argOf(l, 'epochId');
    if (id === undefined) continue;
    const row = ensure(BigInt(id as bigint));
    row.winningSide = Number(argOf(l, 'winningSide') ?? 0) as Side;
    row.potBase = (argOf(l, 'potWETH') as bigint) ?? 0n;
    row.potUSDC = (argOf(l, 'potUSDC') as bigint) ?? 0n;
  }

  for (const l of resolved) {
    const id = argOf(l, 'epochId');
    if (id === undefined) continue;
    const row = ensure(BigInt(id as bigint));
    row.settlePrice18 = (argOf(l, 'settlePrice18') as bigint) ?? undefined;
    row.deltaBps = (argOf(l, 'deltaBps') as bigint) ?? undefined;
    // EpochResolved also carries winningSide; prefer it if settle didn't set one.
    if (row.winningSide === Side.NONE) row.winningSide = Number(argOf(l, 'winningSide') ?? 0) as Side;
  }

  for (const l of rollovers) {
    const id = argOf(l, 'epochId');
    if (id === undefined) continue;
    const row = ensure(BigInt(id as bigint));
    row.rolledOver = true;
    row.winnerCount = 0; // empty-winner rollover => nobody won
    row.winningSide = Number(argOf(l, 'winningSide') ?? row.winningSide) as Side;
    // The rollover event mirrors the forfeited pot; keep settle's pot if already set.
    if (row.potBase === 0n) row.potBase = (argOf(l, 'potWETH') as bigint) ?? 0n;
    if (row.potUSDC === 0n) row.potUSDC = (argOf(l, 'potUSDC') as bigint) ?? 0n;
  }

  return [...rows.values()].sort((a, b) => (b.epochId > a.epochId ? 1 : b.epochId < a.epochId ? -1 : 0));
}

/**
 * v3 (ENTRY-ANCHORED) row builder. Each settled epoch emits EpochSettled with the single settlement
 * price + the count of correct positions; an empty-winner epoch additionally emits EmptyWinnerRollover.
 * There is no global winning side (per-position outcomes), so `winningSide` stays NONE and
 * `perPosition` is set. Pure - unit-testable with mocked logs.
 */
export function buildEpochRowsV3(settled: DecodedLog[], rollovers: DecodedLog[]): EpochHistoryRow[] {
  const rows = new Map<string, EpochHistoryRow>();
  const ensure = (epochId: bigint): EpochHistoryRow => {
    const key = epochId.toString();
    let row = rows.get(key);
    if (!row) {
      row = {
        epochId,
        startPrice18: 0n, // v3 has no global start price
        winningSide: Side.NONE,
        potBase: 0n,
        potUSDC: 0n,
        rolledOver: false,
        perPosition: true,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const l of settled) {
    const id = argOf(l, 'epochId');
    if (id === undefined) continue;
    const row = ensure(BigInt(id as bigint));
    row.settlePrice18 = (argOf(l, 'finalPrice18') as bigint) ?? undefined;
    row.winnerCount = Number(argOf(l, 'winnerCount') ?? 0);
    row.potBase = (argOf(l, 'potBase') as bigint) ?? 0n;
    row.potUSDC = (argOf(l, 'potUSDC') as bigint) ?? 0n;
  }

  for (const l of rollovers) {
    const id = argOf(l, 'epochId');
    if (id === undefined) continue;
    const row = ensure(BigInt(id as bigint));
    row.rolledOver = true;
    row.winnerCount = 0; // empty-winner rollover => nobody's call was correct with fees
    if (row.potBase === 0n) row.potBase = (argOf(l, 'potBase') as bigint) ?? 0n;
    if (row.potUSDC === 0n) row.potUSDC = (argOf(l, 'potUSDC') as bigint) ?? 0n;
  }

  return [...rows.values()].sort((a, b) => (b.epochId > a.epochId ? 1 : b.epochId < a.epochId ? -1 : 0));
}

/** react-query result for the active market's epoch history. */
export function useEpochHistory(): UseQueryResult<EpochHistoryRow[], Error> {
  const market = useActiveMarket();
  const chainId = useChainId();
  const arena = market.feeArena;
  const fromBlock = market.fromBlock ?? 0n;
  const v3 = isV3Market(market);

  return useQuery<EpochHistoryRow[], Error>({
    queryKey: ['epochHistory', chainId, market.id, arena, fromBlock.toString(), v3 ? 'v3' : 'v1'],
    queryFn: async () => {
      const client = getPublicClient(wagmiConfig, { chainId: arcTestnet.id });
      if (!client) throw new Error('No RPC client configured.');
      const toBlock = await client.getBlockNumber();

      // ENTRY-ANCHORED (v3): one EpochSettled per settled epoch carries the settlement price +
      // correct-position count; no global start/resolved events. winnerCount is in the event, so
      // no on-chain backfill is needed.
      if (v3) {
        const [settled, rollovers] = await Promise.all([
          getEventLogsChunked(client, { address: arena, event: V3_EPOCH_SETTLED, fromBlock, toBlock }),
          getEventLogsChunked(client, { address: arena, event: V3_EMPTY_WINNER_ROLLOVER, fromBlock, toBlock }),
        ]);
        return buildEpochRowsV3(settled, rollovers);
      }

      const [started, settled, resolved, rollovers] = await Promise.all([
        getEventLogsChunked(client, { address: arena, event: EPOCH_STARTED, fromBlock, toBlock }),
        getEventLogsChunked(client, { address: arena, event: EPOCH_SETTLED, fromBlock, toBlock }),
        getEventLogsChunked(client, { address: arena, event: EPOCH_RESOLVED, fromBlock, toBlock }),
        getEventLogsChunked(client, { address: arena, event: EMPTY_WINNER_ROLLOVER, fromBlock, toBlock }),
      ]);
      const rows = buildEpochRows(started, settled, resolved, rollovers);

      // Backfill winnerCount for settled non-rollover rows via batched on-chain reads.
      // Rolled-over rows already have winnerCount=0 from buildEpochRows; we skip them.
      const settledRows = rows.filter((r) => !r.rolledOver && r.winnerCount === undefined);
      if (settledRows.length > 0) {
        const calls = settledRows.map((r) => ({
          address: arena,
          abi: feeArenaAbi,
          functionName: 'winnerCount' as const,
          args: [r.epochId] as const,
        }));
        const results = await batchReads(client, calls);
        for (let i = 0; i < settledRows.length; i++) {
          const res = results[i];
          if (res.status === 'success') {
            settledRows[i].winnerCount = Number(res.result as number | bigint);
          }
        }
      }

      return rows;
    },
    staleTime: 30_000,
    retry: 1,
  });
}
