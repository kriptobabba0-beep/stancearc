// reserveGovernor.ts — PURE drawdown math for the owner reserve (0x891b…) that funds the
// gas-watchdog's keeper-signer refills. The gas-burn DRAIN bug is fixed, but a sustained
// LEGITIMATE burn can still outpace the human's faucet top-ups and slowly bleed the reserve
// to empty — at which point the watchdog can't refill the signer and the whole keeper wedges
// on insufficient gas. Watching only the ABSOLUTE level is too late: by the time the balance
// is "low" there may be minutes, not hours, of runway left. So this module measures the
// drawdown RATE over a sliding window and projects the time-to-floor, giving the operator
// HOURS of warning. It also tells the loop to THROTTLE its cadence as the reserve nears the
// floor (slower polling burns less gas) and to STOP at the floor.
//
// Like backoff.ts / heartbeat.ts this is pure: the LOOP samples the reserve balance each tick
// and feeds (now, wei) in; every function reads no clock and returns NEW state, so the rate +
// projection accounting is deterministic and unit-testable. Balances are bigint wei; we
// PERSIST/SAMPLE them as decimal strings (JSON has no bigint) and parse back with BigInt.

/** One reserve-balance observation. `wei` is a DECIMAL STRING so the history survives JSON. */
export interface ReserveSample {
  ts: number;
  wei: string;
}

/** The sliding window of samples the loop carries across ticks. */
export interface ReserveHistory {
  samples: ReserveSample[];
}

/** Inputs for the full decision. All wei are bigint; thresholds are operator-tuned. */
export interface ReserveParams {
  /** Latest reserve balance (the loop's freshest read). */
  currentWei: bigint;
  /** Stop/throttle floor — the reserve must stay above this or the keeper halts. */
  floorWei: bigint;
  /** Begin throttling at/below this level (caller should keep this >= floorWei). */
  throttleWei: bigint;
  /** Alert if the MEASURED drawdown rate exceeds this many wei/hour. */
  warnDrawdownWeiPerHour: bigint;
  /** Alert if the projected time-to-floor (ms) drops below this. */
  projectDryWarnMs: number;
}

/** The loop-facing decision: what to alert on, whether to slow down, whether to stop. */
export interface ReserveDecision {
  /** Measured drawdown rate (wei/hour); null when <2 samples or the reserve is not draining. */
  drawdownWeiPerHour: bigint | null;
  /** ms until the reserve hits floorWei at the current rate; null if not draining / already low. */
  projectedDryMs: number | null;
  /** Highest-severity reason to alert (precedence floor > projection > rate > none). */
  alert: 'none' | 'rate' | 'projection' | 'floor';
  /** Slow the loop cadence: currentWei <= throttleWei. */
  throttle: boolean;
  /** Halt: currentWei <= floorWei. */
  stop: boolean;
}

/** One hour in ms — the unit we normalize the drawdown rate to. */
const HOUR_MS = 3_600_000n;

/** A fresh, empty history. */
export function freshReserveHistory(): ReserveHistory {
  return { samples: [] };
}

/**
 * Append a sample and prune everything older than `now - retainMs`. PURE — returns a NEW
 * history (never mutates the input array). Pruning bounds the window so the measured rate
 * reflects RECENT drawdown, not the whole run, and keeps the persisted history small.
 */
export function recordReserve(
  history: ReserveHistory,
  ts: number,
  wei: bigint,
  retainMs: number,
): ReserveHistory {
  const cutoff = ts - retainMs;
  // Keep only in-window samples (strictly older-than-cutoff are dropped), then append the new
  // one. Filtering the existing array first means a stale sample whose ts == the new one's
  // cutoff is pruned consistently regardless of insertion order.
  const kept = history.samples.filter((s) => s.ts >= cutoff);
  return { samples: [...kept, { ts, wei: wei.toString() }] };
}

/**
 * Measured drawdown rate in wei/hour from the OLDEST to the NEWEST in-window sample.
 * Returns null when there are <2 samples (can't measure a slope) or when the reserve GREW
 * over the window (delta <= 0 — not draining, nothing to warn about). Guards divide-by-zero
 * when two samples share a timestamp. PURE.
 *
 *   delta = oldest.wei - newest.wei            (positive while draining)
 *   rate  = delta * 3_600_000 / (newest.ts - oldest.ts)
 */
export function drawdownWeiPerHour(history: ReserveHistory, now: number): bigint | null {
  void now; // the rate spans the samples themselves; `now` is accepted for call-site symmetry
  const samples = history.samples;
  if (samples.length < 2) return null;
  const oldest = samples[0]!;
  const newest = samples[samples.length - 1]!;
  const dtMs = newest.ts - oldest.ts;
  if (dtMs <= 0) return null; // same instant (or out-of-order) — no measurable slope
  const delta = BigInt(oldest.wei) - BigInt(newest.wei);
  if (delta <= 0n) return null; // reserve held flat or grew — not draining
  return (delta * HOUR_MS) / BigInt(dtMs);
}

/**
 * Project ms until `currentWei` reaches `floorWei` at the measured drawdown rate. Returns
 * null when the reserve is not draining (no rate) or is already at/below the floor (no runway
 * left to project). PURE.
 *
 *   ms = (currentWei - floorWei) * 3_600_000 / ratePerHour
 *
 * The whole expression is integer bigint math; the final Number() is safe because a realistic
 * runway (hours/days in ms) is far below Number.MAX_SAFE_INTEGER. Even an absurdly large
 * value only loses sub-ms precision, which does not matter for an hours-out projection.
 */
export function projectDryMs(
  history: ReserveHistory,
  now: number,
  currentWei: bigint,
  floorWei: bigint,
): number | null {
  const rate = drawdownWeiPerHour(history, now);
  if (rate === null || rate <= 0n) return null; // not draining — no projection
  const headroom = currentWei - floorWei;
  if (headroom <= 0n) return null; // already at/below floor — nothing to project
  return Number((headroom * HOUR_MS) / rate);
}

/**
 * The full decision. PURE. Computes the rate + projection once, then resolves the loop
 * signals. Alert precedence (highest severity wins):
 *   'floor'      — currentWei <= floorWei (we are stopping NOW)
 *   'projection' — projectedDryMs != null && < projectDryWarnMs (dry SOON)
 *   'rate'       — drawdownWeiPerHour != null && > warnDrawdownWeiPerHour (fast bleed)
 *   'none'       — healthy
 * throttle/stop are independent level gates (throttle at throttleWei, stop at floorWei).
 */
export function evaluateReserve(
  history: ReserveHistory,
  now: number,
  params: ReserveParams,
): ReserveDecision {
  const { currentWei, floorWei, throttleWei, warnDrawdownWeiPerHour, projectDryWarnMs } = params;

  const drawdown = drawdownWeiPerHour(history, now);
  const projectedDryMs = projectDryMs(history, now, currentWei, floorWei);

  const stop = currentWei <= floorWei;
  const throttle = currentWei <= throttleWei;

  let alert: ReserveDecision['alert'];
  if (stop) {
    alert = 'floor';
  } else if (projectedDryMs !== null && projectedDryMs < projectDryWarnMs) {
    alert = 'projection';
  } else if (drawdown !== null && drawdown > warnDrawdownWeiPerHour) {
    alert = 'rate';
  } else {
    alert = 'none';
  }

  return { drawdownWeiPerHour: drawdown, projectedDryMs, alert, throttle, stop };
}
