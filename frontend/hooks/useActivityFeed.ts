'use client';

import { useEffect, useRef, useState } from 'react';
import { getPublicClient } from 'wagmi/actions';
import {
  getRecentFeeArenaLogs,
  watchFeeArenaEvents,
  dedupeKey,
  type FeedLog,
} from '@/lib/events';
import { wagmiConfig } from '@/lib/wagmi';
import { arcTestnet } from '@/lib/chain';
import { useMarketContracts } from '@/lib/contracts';

export interface FeedItem extends FeedLog {
  key: string;
  /** Chain-time (seconds) of the log's block, resolved best-effort for relative-time display. */
  blockTimestamp?: bigint;
}

const MAX_ITEMS = 50;

/**
 * Activity feed: getLogs backfill on mount + live watch on top (OPTIMIZATION only).
 * Deduped on (blockNumber, logIndex); newest first. UI state never depends solely on events.
 *
 * Each item is enriched best-effort with its block timestamp (resolved once per block via a cached
 * getBlock fan-out) so the feed can show relative time ("2m ago"). A failed/absent timestamp simply
 * omits the relative-time label — it never affects correctness (UI state derives from polled reads).
 */
export function useActivityFeed(): { events: FeedItem[] } {
  const { feeArena } = useMarketContracts();
  const arena = feeArena.address;
  const [events, setEvents] = useState<FeedItem[]>([]);
  const seen = useRef<Set<string>>(new Set());
  // Per-block timestamp cache (seconds), shared across renders; reset on market switch below.
  const blockTimes = useRef<Map<string, bigint>>(new Map());

  const merge = (incoming: FeedLog[]) => {
    if (incoming.length === 0) return;
    setEvents((prev) => {
      const next = [...prev];
      for (const l of incoming) {
        const key = dedupeKey(l);
        if (seen.current.has(key)) continue;
        seen.current.add(key);
        const cached = blockTimes.current.get(l.blockNumber.toString());
        // Only a real (>=0) timestamp counts; -1 is an in-flight placeholder.
        next.push({ ...l, key, blockTimestamp: cached !== undefined && cached >= 0n ? cached : undefined });
      }
      next.sort((a, b) =>
        b.blockNumber === a.blockNumber
          ? b.logIndex - a.logIndex
          : b.blockNumber > a.blockNumber
            ? 1
            : -1,
      );
      return next.slice(0, MAX_ITEMS);
    });
  };

  /**
   * Resolve block timestamps for any visible item that lacks one (cached per block to bound RPC).
   * Best-effort: failures are swallowed and simply leave the relative-time label off that row.
   */
  const resolveTimestamps = (active: () => boolean) => {
    setEvents((prev) => {
      const missing = [...new Set(prev.filter((e) => e.blockTimestamp === undefined).map((e) => e.blockNumber))];
      if (missing.length === 0) return prev;
      const client = getPublicClient(wagmiConfig, { chainId: arcTestnet.id });
      if (!client) return prev;
      for (const bn of missing) {
        if (blockTimes.current.has(bn.toString())) continue;
        // Mark as in-flight (placeholder) so we don't re-request the same block repeatedly.
        blockTimes.current.set(bn.toString(), -1n);
        client
          .getBlock({ blockNumber: bn })
          .then((block) => {
            if (!active()) return;
            blockTimes.current.set(bn.toString(), block.timestamp);
            setEvents((cur) =>
              cur.map((e) => (e.blockNumber === bn ? { ...e, blockTimestamp: block.timestamp } : e)),
            );
          })
          .catch(() => {
            // Leave the placeholder so we don't hammer a flaky RPC; relative time just won't show.
          });
      }
      return prev;
    });
  };

  useEffect(() => {
    let active = true;
    // Switching market = a different arena: clear the accumulated feed + dedupe + block-time cache.
    seen.current = new Set();
    blockTimes.current = new Map();
    setEvents([]);
    getRecentFeeArenaLogs(undefined, arena)
      .then((logs) => {
        if (active) merge(logs);
      })
      .catch(() => {
        /* backfill is best-effort; polling-driven UI is unaffected */
      });
    const unwatch = watchFeeArenaEvents((logs) => {
      if (active) merge(logs);
    }, arena);
    // Periodically resolve any missing block timestamps for the visible items.
    const isActive = () => active;
    resolveTimestamps(isActive);
    const id = setInterval(() => resolveTimestamps(isActive), 5_000);
    return () => {
      active = false;
      clearInterval(id);
      unwatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arena]);

  return { events };
}
