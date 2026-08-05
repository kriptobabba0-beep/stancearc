// lib/events.ts - watchContractEvent wrapper: onError re-subscribe + getLogs fallback + (blockNumber,logIndex) dedupe.
// OPTIMIZATION ONLY. UI state derives from polled reads; correctness must survive every event being dropped.
import type { PublicClient, Abi, AbiEvent, Log, GetLogsReturnType } from 'viem';
import { getPublicClient } from 'wagmi/actions';
import { wagmiConfig } from '@/lib/wagmi';
import { arcTestnet } from '@/lib/chain';
import { feeArena } from '@/lib/contracts';

/** Default arena (the first/ETH market) used when no explicit address is passed. */
const DEFAULT_ARENA = feeArena.address;

// ─── FeedLog types + helpers ───────────────────────────────────────────────

export interface FeedLog {
  eventName: string;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
  args: Record<string, unknown>;
}

export const dedupeKey = (l: { blockNumber: bigint; logIndex: number }) =>
  `${l.blockNumber.toString()}:${l.logIndex}`;

function toFeedLogs(logs: Log[]): FeedLog[] {
  return logs
    .filter((l) => l.blockNumber != null && l.logIndex != null)
    .map((l) => ({
      eventName: (l as unknown as { eventName?: string }).eventName ?? 'Event',
      blockNumber: l.blockNumber as bigint,
      logIndex: l.logIndex as number,
      transactionHash: l.transactionHash as `0x${string}`,
      args: ((l as unknown as { args?: Record<string, unknown> }).args ?? {}),
    }));
}

/** Backfill: all FeeArena events in the last `lookback` blocks (getLogs fallback path). Defaults to the ETH arena. */
export async function getRecentFeeArenaLogs(
  lookback = 5_000n,
  arena: `0x${string}` = DEFAULT_ARENA,
): Promise<FeedLog[]> {
  const client = getPublicClient(wagmiConfig, { chainId: arcTestnet.id });
  if (!client) return [];
  const tip = await client.getBlockNumber();
  const from = tip > lookback ? tip - lookback : 0n;
  const logs = await client.getLogs({
    address: arena,
    fromBlock: from,
    toBlock: 'latest',
  });
  return toFeedLogs(logs as Log[]);
}

/** Live subscription with onError re-subscribe; returns an unwatch fn. Defaults to the ETH arena. */
export function watchFeeArenaEvents(
  onLogs: (logs: FeedLog[]) => void,
  arena: `0x${string}` = DEFAULT_ARENA,
): () => void {
  const client = getPublicClient(wagmiConfig, { chainId: arcTestnet.id });
  if (!client) return () => {};
  let unwatch = subscribe();
  function subscribe() {
    return client!.watchContractEvent({
      address: arena,
      abi: feeArena.abi,
      onLogs: (raw) => onLogs(toFeedLogs(raw as Log[])),
      onError: () => {
        // re-subscribe on transport error (watchContractEvent is best-effort)
        try {
          unwatch?.();
        } catch {
          /* noop */
        }
        unwatch = subscribe();
      },
    });
  }
  return () => unwatch?.();
}

// ─── Generic watchArenaEvents (pre-existing, used by other groups) ──────────

type Handler = (logs: Log[]) => void;

interface WatchArgs {
  client: PublicClient;
  address: `0x${string}`;
  abi: Abi;
  onLogs: Handler;
  pollingInterval?: number;
}

/** Subscribe to all events for a contract with dedupe + getLogs catch-up + auto re-subscribe on error. */
export function watchArenaEvents({ client, address, abi, onLogs, pollingInterval = 4000 }: WatchArgs): () => void {
  const seen = new Set<string>();
  let lastBlock: bigint | undefined;
  let unwatch: (() => void) | undefined;
  let stopped = false;

  const key = (l: Log) => `${l.blockNumber?.toString() ?? 'p'}:${l.logIndex?.toString() ?? 'p'}`;
  const emitNew = (logs: Log[]) => {
    const fresh = logs.filter((l) => {
      const k = key(l);
      if (seen.has(k)) return false;
      seen.add(k);
      if (l.blockNumber != null && (lastBlock === undefined || l.blockNumber > lastBlock)) lastBlock = l.blockNumber;
      return true;
    });
    if (fresh.length) onLogs(fresh);
  };

  const catchUp = async () => {
    try {
      const logs = await client.getLogs({ address, fromBlock: lastBlock, toBlock: 'latest' });
      emitNew(logs as Log[]);
    } catch { /* polling remains the source of truth; ignore fallback failures */ }
  };

  const subscribe = () => {
    if (stopped) return;
    unwatch = client.watchContractEvent({
      address,
      abi,
      pollingInterval,
      onLogs: (logs) => emitNew(logs as Log[]),
      onError: () => {
        unwatch?.();
        void catchUp().finally(() => { if (!stopped) setTimeout(subscribe, 1000); });
      },
    });
  };

  void catchUp().finally(subscribe); // initial catch-up then live subscription
  return () => { stopped = true; unwatch?.(); };
}

// ─── Chunked historical getLogs (history / leaderboard backfill) ────────────
// Public RPCs cap getLogs block ranges; we walk [fromBlock..toBlock] in CHUNK_BLOCKS windows so a
// market deployed thousands of blocks ago still backfills without tripping the RPC range limit.
// Windows are fetched with BOUNDED parallelism (CHUNK_CONCURRENCY batches of Promise.all) to
// minimise wall-clock time on large ranges without overwhelming the RPC endpoint.

/** Default block-range window per getLogs call (conservative; most public RPCs allow ≥ this). */
export const CHUNK_BLOCKS = 9_000n;

/** Number of windows fetched concurrently per batch (bounds RPC fan-out). */
export const CHUNK_CONCURRENCY = 5;

/**
 * getLogs for a single ABI event over [fromBlock..toBlock], chunked to respect RPC range limits.
 * Decoded (eventName + typed args) because `event` is passed. Returns logs in ascending block order.
 * Throws on RPC failure so callers (react-query) can surface an error + retry.
 *
 * Windows are dispatched in parallel batches of CHUNK_CONCURRENCY to bound wall-clock time on
 * large ranges (e.g. when `fromBlock` defaults to 0 on a market with many historical blocks).
 * Per-market `fromBlock` in NEXT_PUBLIC_MARKETS config is strongly recommended to keep the range
 * small (see .env.example); NEXT_PUBLIC_FEE_ARENA_FROM_BLOCK does NOT apply when
 * NEXT_PUBLIC_MARKETS is set - each market entry must carry its own `fromBlock`.
 */
export async function getEventLogsChunked<TEvent extends AbiEvent>(
  client: PublicClient,
  args: {
    address: `0x${string}`;
    event: TEvent;
    fromBlock: bigint;
    toBlock: bigint;
    chunkBlocks?: bigint;
    concurrency?: number;
    /**
     * Optional INDEXED-arg filter (e.g. `{ owner: '0x…' }`). When set, the RPC bloom-filters each
     * window to matching logs only - so a per-user query returns a handful of logs instead of every
     * position's, and skips blocks without the topic. Forwarded verbatim to getLogs.
     */
    eventArgs?: Record<string, unknown>;
  },
): Promise<GetLogsReturnType<TEvent>> {
  const { address, event, fromBlock, toBlock, chunkBlocks = CHUNK_BLOCKS, concurrency = CHUNK_CONCURRENCY, eventArgs } = args;
  if (toBlock < fromBlock) return [] as unknown as GetLogsReturnType<TEvent>;

  // Build the full list of [start, end] windows up front.
  const windows: [bigint, bigint][] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkBlocks + 1n) {
    const end = start + chunkBlocks > toBlock ? toBlock : start + chunkBlocks;
    windows.push([start, end]);
  }

  // Fetch in parallel batches to bound RPC fan-out while cutting wall-clock time.
  const out: unknown[] = [];
  for (let i = 0; i < windows.length; i += concurrency) {
    const batch = windows.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(([start, end]) =>
        client.getLogs({
          address,
          event,
          fromBlock: start,
          toBlock: end,
          ...(eventArgs ? { args: eventArgs } : {}),
        } as Parameters<PublicClient['getLogs']>[0]),
      ),
    );
    for (const logs of results) out.push(...logs);
  }
  return out as GetLogsReturnType<TEvent>;
}
