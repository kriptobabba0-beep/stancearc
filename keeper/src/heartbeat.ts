// heartbeat.ts - the PURE heartbeat-volume budget ledger (TASK 3b). The decision of WHETHER
// to emit a heartbeat leg lives in decideArb (pure, given an injected HeartbeatState
// snapshot). This module owns the running BUDGET state that the arb executor carries across
// ticks: the day's spend, the last heartbeat timestamp, and the UTC-day boundary used to
// reset the daily cap. All functions are pure (clock is injected as nowMs) so the
// interval + daily-cap accounting is deterministic + unit-testable, mirroring backoff.ts.
//
// The ledger is the executor's source of truth; decideArb only READS a snapshot of it
// (nowMs + lastHeartbeatMs + spentTodayBase). The executor:
//   1) rolls the day at a UTC midnight boundary (rollHeartbeatDay) BEFORE deciding,
//   2) snapshots the ledger for the decision (snapshotHeartbeat),
//   3) records the spend AFTER a heartbeat swap settles (recordHeartbeatSpend).

import type { HeartbeatState } from './decideArb.js';

/** Milliseconds in a UTC day - the daily-cap reset window. */
export const DAY_MS = 86_400_000;

/** The executor-owned, mutable-by-copy MM ledger (heartbeat + rebalance) carried across ticks. */
export interface HeartbeatLedger {
  /** Start (ms, UTC-day-aligned) of the current budget day. */
  dayStartMs: number;
  /** Base notional (raw at baseDecimals) spent on heartbeat volume in the current day. */
  spentTodayBase: bigint;
  /** Wall-clock (ms) of the last heartbeat leg, or null if none yet. */
  lastHeartbeatMs: number | null;
  /**
   * FINDING 4 - heartbeat ATTEMPTS made in the current day, stamped on EVERY attempt
   * (success OR revert). The notional cap (spentTodayBase) only advances on success, so a
   * reverting leg can't charge it; this attempt counter bounds the retries instead. Resets
   * with the day.
   */
  heartbeatAttemptsToday: number;
  /**
   * FINDING 3 - wall-clock (ms) of the last REBALANCE leg, or null if none yet. Gives the
   * rebalance path the same interval rate-limit the heartbeat already had. Stamped on EVERY
   * rebalance attempt (regardless of success) so a reverting rebalance can't fire each poll.
   */
  lastRebalanceMs: number | null;
  /** FINDING 4 - rebalance ATTEMPTS in the current day (stamped on every attempt). Resets daily. */
  rebalanceAttemptsToday: number;
}

/** UTC-day start (ms) for a given instant - floors to the previous midnight UTC. */
export function utcDayStart(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

/** A fresh ledger anchored to the current day (no spend, no prior heartbeat/rebalance). */
export function freshHeartbeatLedger(nowMs: number): HeartbeatLedger {
  return {
    dayStartMs: utcDayStart(nowMs),
    spentTodayBase: 0n,
    lastHeartbeatMs: null,
    heartbeatAttemptsToday: 0,
    lastRebalanceMs: null,
    rebalanceAttemptsToday: 0,
  };
}

/**
 * Roll the budget day if `nowMs` has crossed into a new UTC day: returns a ledger with the
 * day reset (spend back to 0, dayStartMs advanced) - otherwise returns the ledger unchanged.
 * PURE: returns a NEW object on a roll, the SAME reference when no roll is needed. The
 * lastHeartbeatMs is preserved across a roll so the interval rate-limit still spans midnight.
 */
export function rollHeartbeatDay(ledger: HeartbeatLedger, nowMs: number): HeartbeatLedger {
  const today = utcDayStart(nowMs);
  if (today <= ledger.dayStartMs) return ledger; // same (or earlier) day - no roll
  return {
    dayStartMs: today,
    spentTodayBase: 0n,
    // lastHeartbeatMs/lastRebalanceMs survive a roll so the interval rate-limits still span
    // midnight; only the per-day spend + attempt COUNTERS reset with the new day.
    lastHeartbeatMs: ledger.lastHeartbeatMs,
    heartbeatAttemptsToday: 0,
    lastRebalanceMs: ledger.lastRebalanceMs,
    rebalanceAttemptsToday: 0,
  };
}

/**
 * The immutable snapshot decideArb consumes. Threads the injected clock + the ledger's
 * spend/last-fire so the decision is a pure function of its inputs (no clock read inside).
 */
export function snapshotHeartbeat(ledger: HeartbeatLedger, nowMs: number): HeartbeatState {
  return {
    nowMs,
    lastHeartbeatMs: ledger.lastHeartbeatMs,
    spentTodayBase: ledger.spentTodayBase,
    heartbeatAttemptsToday: ledger.heartbeatAttemptsToday,
    lastRebalanceMs: ledger.lastRebalanceMs,
    rebalanceAttemptsToday: ledger.rebalanceAttemptsToday,
  };
}

/**
 * Record a SETTLED heartbeat leg of `amountBase` (raw) at `nowMs`: advances the day's SPEND
 * (the notional cap) and stamps lastHeartbeatMs. Called only on a SUCCESSFUL heartbeat swap
 * (a revert must not charge the notional cap). The interval/attempt rate-limit is handled
 * separately by recordHeartbeatAttempt (stamped regardless of success - FINDING 4) so a
 * reverting leg still advances the rate-limit. PURE - returns a NEW ledger; clamps negatives.
 */
export function recordHeartbeatSpend(
  ledger: HeartbeatLedger,
  amountBase: bigint,
  nowMs: number,
): HeartbeatLedger {
  const add = amountBase > 0n ? amountBase : 0n;
  return {
    ...ledger,
    spentTodayBase: ledger.spentTodayBase + add,
    lastHeartbeatMs: nowMs,
  };
}

/**
 * FINDING 4 - record a heartbeat ATTEMPT at `nowMs`: stamps lastHeartbeatMs (so the interval
 * rate-limit advances) and bumps the per-day attempt counter. Called on EVERY heartbeat swap
 * attempt - success OR revert - so a reverting leg (FINDING 1) advances the rate-limit + the
 * attempt cap and can never retry unbounded. PURE - returns a NEW ledger.
 */
export function recordHeartbeatAttempt(ledger: HeartbeatLedger, nowMs: number): HeartbeatLedger {
  return {
    ...ledger,
    lastHeartbeatMs: nowMs,
    heartbeatAttemptsToday: ledger.heartbeatAttemptsToday + 1,
  };
}

/**
 * FINDING 3/4 - record a REBALANCE ATTEMPT at `nowMs`: stamps lastRebalanceMs (the rebalance
 * interval rate-limit) and bumps the per-day rebalance attempt counter. Called on EVERY
 * rebalance swap attempt regardless of success, so a reverting rebalance advances its
 * governor and can't fire every poll. PURE - returns a NEW ledger.
 */
export function recordRebalanceAttempt(ledger: HeartbeatLedger, nowMs: number): HeartbeatLedger {
  return {
    ...ledger,
    lastRebalanceMs: nowMs,
    rebalanceAttemptsToday: ledger.rebalanceAttemptsToday + 1,
  };
}
