// hooks/usePollInterval.ts - refetchInterval policy: ~5s baseline, ~2s near phase boundaries / after writes.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { EpochView } from '@/lib/types';
import { useChainTime } from '@/hooks/useChainTime';

const BASELINE_MS = 5000;
const FAST_MS = 2000;
const NEAR_BOUNDARY_S = 15n;     // within 15s of a boundary -> fast poll
const AFTER_WRITE_MS = 20000;    // fast for 20s after any write

// ── Reactive last-write store (Bug 1c) ──────────────────────────────────────────────
// A module-level timestamp alone doesn't trigger a re-render, so consumers would only pick up the
// faster poll on their NEXT render. Back it with a tiny external store (useSyncExternalStore) so
// bumpPollAfterWrite() notifies all mounted usePollInterval() consumers immediately.
let lastWriteAt = 0;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): number {
  return lastWriteAt;
}

// Server snapshot is a constant 0 - no writes happen during SSR (avoids a hydration mismatch).
function getServerSnapshot(): number {
  return 0;
}

/** Call on every write submit (write hooks invoke this) to bump polling to fast for a short window. */
export function bumpPollAfterWrite(): void {
  lastWriteAt = Date.now();
  // Notify subscribers synchronously so consumers re-render and immediately apply FAST_MS.
  for (const cb of listeners) cb();
}

export function usePollInterval(epoch?: EpochView): number {
  const { now } = useChainTime(); // chain-time seconds (bigint)
  const [, force] = useState(0);

  // Subscribe to the last-write store so a write re-renders this consumer immediately (Bug 1c).
  const writeAt = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Re-evaluate shortly after the post-write window so we relax back to baseline.
  useEffect(() => {
    if (Date.now() - writeAt < AFTER_WRITE_MS) {
      const t = setTimeout(() => force((n) => n + 1), AFTER_WRITE_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [writeAt]);

  if (Date.now() - writeAt < AFTER_WRITE_MS) return FAST_MS;

  if (epoch) {
    const boundaries = [epoch.entryCloseTime, epoch.startTime, epoch.endTime];
    for (const b of boundaries) {
      if (b === 0n) continue;
      const d = b > now ? b - now : now - b;
      if (d <= NEAR_BOUNDARY_S) return FAST_MS;
    }
  }
  return BASELINE_MS;
}
