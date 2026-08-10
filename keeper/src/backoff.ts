// backoff.ts — PURE per-market circuit-breaker math. A market that keeps failing (RPC
// error, reverted crank, Hermes hang, or a STUCK/wedged epoch) must NOT be retried at
// full poll rate forever: that burns gas + spams the chain. These helpers compute an
// exponential backoff with a cap and a skip decision; the LOOP (index.ts) owns the
// mutable per-market runtime state and calls these — they read no clock and hold no
// state, so they are trivially unit-testable.

/** Mutable per-market runtime state held by the loop (NOT by the per-tick crank). */
export interface MarketRuntime {
  /** Consecutive failing/STUCK/reverted ticks since the last success (0 when healthy). */
  consecutiveFailures: number;
  /** Wall-clock ms before which the market is skipped (0 = not backing off). */
  backoffUntilMs: number;
  /**
   * The epochId for which a sweep() transaction has successfully been confirmed.
   * Null until the first successful sweep is recorded. Used by decideAction to
   * ensure empty epochs (stakedCount==0) receive exactly one sweep() call before
   * finalizeSettle() — without this, cursor==0==total would skip sweep entirely
   * and finalizeSettle would revert "not Swept" forever.
   */
  lastSweptEpochId: bigint | null;
  // --- Observability (Phase 4). These are OWNED + ASSIGNED BY THE LOOP, not by the
  // pure helpers below — keeping freshRuntime/recordFailure/recordSuccess returning
  // only the breaker fields means their unit tests' toEqual assertions stay exact.
  // All optional with safe defaults so a fresh slot reads as healthy. ---
  /** The action label from this market's most recent tick (e.g. "SWEEP", "NONE"). */
  lastAction?: string;
  /** Wall-clock ms when lastAction was recorded. */
  lastActionTs?: number;
  /**
   * True once consecutiveFailures >= the WEDGED alert threshold; cleared on the next
   * success. Surfaced by /health to flip the keeper to DEGRADED. Optional (undefined
   * on a fresh slot) and read as `wedged ?? false`.
   */
  wedged?: boolean;
  /**
   * v2 ONLY (liveness observability) — consecutive ticks this market's PINNED start/end
   * window was MISSED (rec.windowState==='MISSED': now past the safe tail of
   * [endpointTime, endpointTime+settleWindow]). Distinct from `consecutiveFailures` (which
   * counts ALL failure modes) so a chronically-too-tight settle window — e.g. a 12s window
   * the keeper can't reliably hit due to mine latency — is diagnosed SPECIFICALLY before it
   * silently relies on the owner's emergencySettle. Reset to 0 on any non-MISSED tick.
   * Owned + assigned BY THE LOOP (index.ts), like the other observability fields. Read as
   * `consecutiveMissedWindows ?? 0`.
   */
  consecutiveMissedWindows?: number;
}

/** A fresh, healthy runtime slot. */
export function freshRuntime(): MarketRuntime {
  return { consecutiveFailures: 0, backoffUntilMs: 0, lastSweptEpochId: null };
}

/**
 * Exponential backoff for the Nth consecutive failure: base * 2^(failures-1), capped.
 * failures <= 0 means "no failures" -> 0 (no backoff). PURE.
 */
export function nextBackoffMs(failures: number, baseMs: number, maxMs: number): number {
  if (failures <= 0) return 0;
  // Cap the exponent so 2^(failures-1) can't overflow to Infinity before the min().
  const exp = Math.min(failures - 1, 53);
  const raw = baseMs * 2 ** exp;
  return Math.min(raw, maxMs);
}

/** True while the market is still inside its backoff window (skip it this tick). PURE. */
export function shouldSkip(state: MarketRuntime, nowMs: number): boolean {
  return nowMs < state.backoffUntilMs;
}

/**
 * Apply a FAILURE outcome: bump the failure count and arm the next backoff window.
 * Returns a NEW state (does not mutate). PURE.
 * NOTE: lastSweptEpochId is PRESERVED across failures — a sweep that already succeeded
 * for this epoch must not be forgotten just because a subsequent crank failed.
 */
export function recordFailure(
  state: MarketRuntime,
  nowMs: number,
  baseMs: number,
  maxMs: number,
): MarketRuntime {
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    backoffUntilMs: nowMs + nextBackoffMs(consecutiveFailures, baseMs, maxMs),
    lastSweptEpochId: state.lastSweptEpochId,
  };
}

/**
 * Apply a SUCCESS outcome: reset the circuit-breaker fields. Returns a NEW state. PURE.
 * NOTE: lastSweptEpochId is PRESERVED — the caller (index.ts) is responsible for
 * explicitly updating it after a confirmed SWEEP success.
 */
export function recordSuccess(state: MarketRuntime): MarketRuntime {
  return {
    consecutiveFailures: 0,
    backoffUntilMs: 0,
    lastSweptEpochId: state.lastSweptEpochId,
  };
}
