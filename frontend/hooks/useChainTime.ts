// hooks/useChainTime.ts — chain-time offset from block.timestamp for countdowns.
//
// Periodically re-samples `block.timestamp` (every RESAMPLE_INTERVAL_MS, default 45 s) so the
// chain↔local-clock offset is refreshed throughout a long session and countdowns/poll-proximity
// stay aligned to chain time without drifting. The first sample is taken immediately on mount.
// Falls back to offset=0 (local clock) if the RPC call fails.
// Countdowns/poll proximity MUST use `now` here (never the raw local clock directly).
import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { ARC_CHAIN_ID } from '@/lib/chain';

export interface ChainTime {
  /** Best-estimate current chain time in seconds (block.timestamp + elapsed since sample). */
  now: bigint;
  /** Signed offset (ms) between chain time and the local clock: chainMs - Date.now(). */
  offsetMs: number;
}

/** How often to re-sample block.timestamp to refresh the chain↔local-clock offset (ms). */
const RESAMPLE_INTERVAL_MS = 45_000;

export function useChainTime(): ChainTime {
  const client = usePublicClient({ chainId: ARC_CHAIN_ID });
  const [offsetMs, setOffsetMs] = useState(0);
  const [, tick] = useState(0);

  // Periodically re-sample block.timestamp and update the offset.
  // Runs immediately on mount (via the leading sample inside the interval helper), then every
  // RESAMPLE_INTERVAL_MS. Cleanup cancels any in-flight fetch and clears the interval.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    const sample = async () => {
      try {
        const block = await client.getBlock({ blockTag: 'latest' });
        if (cancelled) return;
        setOffsetMs(Number(block.timestamp) * 1000 - Date.now());
      } catch {
        /* offset unchanged — falls back to the local clock; correctness lives in contract phase, not here */
      }
    };

    // Leading sample: run immediately so the first render is not stale.
    void sample();

    const id = setInterval(() => void sample(), RESAMPLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client]);

  // Re-render every second so consumers (countdowns) see `now` advance.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = BigInt(Math.floor((Date.now() + offsetMs) / 1000));
  return { now, offsetMs };
}
