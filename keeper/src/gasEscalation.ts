// gasEscalation.ts — PURE bounded gas-tip escalation (TASK 4b). PROBLEM: every write in
// keeper.ts + arb.ts pins maxFeePerGas == maxPriorityFeePerGas == a STATIC GAS_FLOOR_GWEI.
// On Arc that floor is normally plenty, but during a congestion spike a floor-priced tx can
// sit unmined until the receipt-wait times out — and a crank that misses its bounded window
// (startEpoch's maxStartDelay, endEpoch's settle window) WEDGES the epoch. A static price has
// no way to bid higher.
//
// FIX (this module): compute the gas overrides for retry attempt N as the floor scaled up by
// a per-attempt multiplier, HARD-CAPPED at a configured ceiling. Attempt 0 is ALWAYS exactly
// the floor (so behavior is byte-for-byte unchanged when escalation is off or the first send
// mines). The executor (keeper.ts/arb.ts) re-sends the SAME logical tx with the next attempt's
// gas ONLY when the prior attempt's receipt-wait timed out (i.e. the tx is stuck/under-priced),
// bounded by maxAttempts so a genuinely-broken tx can't loop forever burning gas.
//
// Clock- and I/O-free + unit-tested, mirroring backoff.ts. Both maxFeePerGas and
// maxPriorityFeePerGas are bumped together (Arc prices the floor on both), and the cap bounds
// BOTH so a runaway multiplier can never bid above the operator's ceiling.

/** The gas overrides applied to a single write attempt. */
export interface GasOverrides {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Tunable escalation policy (resolved from config; OFF when maxAttempts === 0). */
export interface GasEscalationConfig {
  /** Base/floor price (wei) — attempt 0 uses exactly this (unchanged behavior). */
  floorWei: bigint;
  /** Hard ceiling (wei) on BOTH maxFeePerGas + maxPriorityFeePerGas. Never bid above this. */
  capWei: bigint;
  /**
   * Per-attempt multiplier in bps (10_000 = 1.0x = no growth). Each retry multiplies the
   * PREVIOUS attempt's price by this, so attempt N = floor * (mult/1e4)^N, then capped.
   */
  multiplierBps: number;
  /**
   * Max EXTRA attempts after the first send (0 = escalation OFF: only the floor-priced send,
   * exactly as before). A value of e.g. 3 means: floor, then up to 3 escalated re-sends.
   */
  maxAttempts: number;
}

/**
 * Gas overrides for retry `attempt` (0-based). Attempt 0 == the floor EXACTLY (no rounding
 * drift), so an unescalated path is unchanged. For attempt N>0 the price is
 * floor * (multiplierBps/1e4)^N, computed in integer bps to stay bigint-exact, then clamped to
 * `capWei`. A multiplierBps <= 10_000 (<=1.0x) yields a flat floor (no growth) — still capped.
 * PURE.
 */
export function escalatedGas(attempt: number, cfg: GasEscalationConfig): GasOverrides {
  if (attempt <= 0) {
    // Attempt 0 is the floor verbatim (but never above the cap, in case cap < floor by misconfig).
    const p = cfg.floorWei <= cfg.capWei ? cfg.floorWei : cfg.capWei;
    return { maxFeePerGas: p, maxPriorityFeePerGas: p };
  }
  // price = floor * (mult/1e4)^attempt, kept exact by folding each step in bps.
  let price = cfg.floorWei;
  const mult = BigInt(Math.max(0, Math.floor(cfg.multiplierBps)));
  for (let i = 0; i < attempt; i += 1) {
    price = (price * mult) / 10_000n;
    if (price >= cfg.capWei) {
      price = cfg.capWei;
      break; // already at the ceiling — further multiplication can't raise it
    }
  }
  if (price > cfg.capWei) price = cfg.capWei;
  return { maxFeePerGas: price, maxPriorityFeePerGas: price };
}

/** True if escalation is configured ON (at least one extra attempt). PURE. */
export function escalationEnabled(cfg: GasEscalationConfig): boolean {
  return cfg.maxAttempts > 0;
}

/**
 * Total number of send attempts for a write: 1 (the floor send) + maxAttempts escalations.
 * PURE — used by the executor to bound its retry loop.
 */
export function totalAttempts(cfg: GasEscalationConfig): number {
  return 1 + Math.max(0, cfg.maxAttempts);
}
