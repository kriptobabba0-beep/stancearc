// spendGuard.ts — the stateful shell over the PURE spendBreaker, mirroring how index.ts owns
// the mutable runtime while backoff.ts stays pure. It loads the persisted ledger at boot, holds
// it in memory, and exposes exactly the two operations the send path needs: status() to check
// the cap BEFORE each broadcast, and book() to record ACTUAL spend AFTER each one. Every book
// fsync's the ledger to disk (via saveLedgerSync) so the rolling window + the sticky trip survive
// a crash/restart — which is the whole point: a crash-loop must not be able to reset the breaker.
//
// When disabled (no cap configured) every method is a cheap no-op so the keeper behaves exactly
// as before. When ENABLED a ledger path is REQUIRED (config enforces it) so persistence can never
// be silently off — the failure mode the adversarial review flagged.
import {
  type SpendLedger,
  type SpendCaps,
  loadLedger,
  saveLedgerSync,
  recordSpend,
  evaluateCap,
  markTripped,
  freshLedger,
} from './spendBreaker.js';

/** Thrown by the send path when the cap is already open — STOP, do not broadcast (zero gas). */
export class SpendCapTrippedError extends Error {
  constructor(public readonly reason: string | null) {
    super(`keeper spend cap tripped (${reason ?? 'unknown'}) — cranking halted until the ledger is cleared`);
    this.name = 'SpendCapTrippedError';
  }
}

export interface SpendStatus {
  tripped: boolean;
  reason: string | null;
}

export interface SpendGuard {
  readonly enabled: boolean;
  /** Cap verdict right now (sticky-aware). Cheap — call before every broadcast. */
  status(now: number): SpendStatus;
  /** Record actual gas spent (wei), persist (fsync), latch the trip if a cap is now exceeded. */
  book(now: number, wei: bigint): SpendStatus;
  /** The live ledger (for /health + /metrics). */
  snapshot(): SpendLedger;
}

/** A disabled guard: no cap, no persistence, no-ops. Keeps the send path branch-free. */
const NOOP_GUARD: SpendGuard = {
  enabled: false,
  status: () => ({ tripped: false, reason: null }),
  book: () => ({ tripped: false, reason: null }),
  snapshot: () => freshLedger(),
};

/**
 * Build the spend guard. `enabled:false` (or a missing path) yields the no-op guard. When
 * enabled, the ledger is loaded from `path` at construction so a prior window + a prior sticky
 * trip are honored immediately on boot. `retainMs` MUST be >= caps.hourWindowMs (the caller
 * derives it that way) so pruning never drops still-relevant spend.
 */
export function createSpendGuard(opts: {
  enabled: boolean;
  path?: string;
  caps: SpendCaps;
  retainMs: number;
  log: (o: Record<string, unknown>) => void;
}): SpendGuard {
  if (!opts.enabled || !opts.path) return NOOP_GUARD;
  const path = opts.path;
  const { caps, retainMs, log } = opts;

  let ledger = loadLedger(path, log);

  function status(now: number): SpendStatus {
    return evaluateCap(ledger, now, caps);
  }

  function book(now: number, wei: bigint): SpendStatus {
    ledger = recordSpend(ledger, now, wei, retainMs);
    const v = evaluateCap(ledger, now, caps);
    // Latch the trip the FIRST time a cap is exceeded so it survives restarts (sticky on disk).
    if (v.tripped && ledger.trippedAt === null) {
      ledger = markTripped(ledger, now, v.reason ?? 'cap');
    }
    // fsync the spend (and any fresh latch) to disk BEFORE we return — the loop books right after
    // a broadcast, and this is what makes the window crash-proof.
    saveLedgerSync(path, ledger, log);
    return evaluateCap(ledger, now, caps);
  }

  return {
    enabled: true,
    status,
    book,
    snapshot: () => ledger,
  };
}
