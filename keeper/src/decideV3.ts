// decideV3.ts - the PURE decision function for ENTRY-ANCHORED (v3) markets.
//
// The v3 lifecycle is simpler than v1's: there is NO startEpoch (no global start price).
//   create -> open -> [entry window] -> [locked watch] -> SETTLE (submit the settlement
//   average) -> PROCESS (batched per-position outcomes) -> FINALIZE -> UNSTAKE (auto-
//   return backlog) -> CREATE ...
//
// Phase semantics mirror IFeeArenaV3.PhaseView (the contract's derived view):
//   Idle=0, EntryOpen=1, Locked=2, Settling=3, Settled=4
// EntryOpen vs Locked is purely a timestamp split of the SAME internal phase, so the
// decide treats them identically: once `nowSec >= settlementTime`, the next action is
// SETTLE regardless of which of the two the view reports.
//
// Settlement never expires on-chain (a late submit is valid - every position resolves
// against its own anchor), so unlike v1 there is NO terminal STUCK state: the keeper
// keeps attempting SETTLE until it lands; a prolonged failure surfaces through the
// loop's existing failure/backoff/WEDGED alerting.

/** Mirrors IFeeArenaV3.PhaseView exactly. */
export enum PhaseViewV3 {
  Idle = 0,
  EntryOpen = 1,
  Locked = 2,
  Settling = 3,
  Settled = 4,
}

export type ActionV3 = 'NONE' | 'CREATE' | 'OPEN' | 'SETTLE' | 'PROCESS' | 'FINALIZE' | 'UNSTAKE';

/** Minimal on-chain projection a v3 decide needs. All times unix seconds (bigint). */
export interface KeeperStateV3 {
  currentEpochId: bigint;
  phase: PhaseViewV3;
  entryCloseTime: bigint;
  settlementTime: bigint;
  processedCursor: number;
  stakedCount: number;
  nowSec: bigint;
  paused: boolean;
  /**
   * Auto-return backlog of the most recently Settled epoch (all OPTIONAL - reads are
   * best-effort; absent fields disable UNSTAKE, never the lifecycle).
   */
  lastSettledEpochId?: bigint;
  unstakeDone?: number;
  unstakeTotal?: number;
}

/** True when the last settled epoch still has escrowed NFTs to push home. PURE. */
export function hasUnstakeBacklogV3(state: KeeperStateV3): boolean {
  return (
    state.lastSettledEpochId !== undefined &&
    state.lastSettledEpochId !== 0n &&
    state.unstakeDone !== undefined &&
    state.unstakeTotal !== undefined &&
    state.unstakeDone < state.unstakeTotal
  );
}

/**
 * On-chain GRACE window (seconds) FeeArenaV3 enforces before emergencySettle is allowed: it reverts
 * GraceNotElapsed while `block.timestamp <= settlementTime + GRACE`. Mirrors FeeArenaV3.GRACE (600s).
 */
export const GRACE_SECONDS_V3 = 600n;

/**
 * Owner-key recovery decision for a v3 market that cannot settle:
 *   - 'RECOVER'    - the epoch is past settlement, never resolved, and the on-chain grace has
 *                    elapsed: call the owner-only emergencySettle(epochId) now to unwedge it.
 *   - 'WAIT_GRACE' - same wedge shape but grace has NOT elapsed yet (emergencySettle would revert
 *                    GraceNotElapsed): keep trying the normal SETTLE (the oracle may recover) and
 *                    re-check later; do NOT spam emergencySettle.
 *   - 'NONE'       - not a recovery situation (no owner key, healthy/early epoch, wrong phase, or
 *                    ordering can't be confirmed): take no recovery action.
 */
export type RecoveryDecisionV3 = 'RECOVER' | 'WAIT_GRACE' | 'NONE';

/**
 * Decide whether the owner key should emergencySettle a v3 epoch that is stuck UNSETTLED. PURE.
 *
 * Fires ONLY for the genuinely-unrecoverable SETTLE wedge (Hermes/oracle dead, or every submit
 * rejected) - NOT for a Settling epoch mid-process (those are bounded by the gas-fit + O(1) solvency
 * and resolve positions properly; emergency-settling them would needlessly discard outcomes). Every
 * condition the contract's emergencySettle enforces is checked here so a doomed tx is never signed:
 *   1. an owner key is configured (absent → 'NONE', behavior unchanged);
 *   2. the epoch is still in the entry/lock phase (internal EntryOpen → emergencySettle-eligible);
 *   3. we are at/past settlementTime (a healthy pre-settlement epoch is never touched);
 *   4. epochId == lastSettledEpochId + 1 == currentEpochId (the contract's exact ordering guard);
 *   5. the on-chain grace has elapsed (else 'WAIT_GRACE' - keep trying SETTLE, don't spam).
 * The 600s grace window is itself the "genuinely stuck" confirmation: if the keeper couldn't land a
 * settlement for 10 minutes past settlementTime, the oracle path is dead and rollover-via-emergency
 * is the correct, fund-preserving escape.
 */
export function decideRecoveryV3(state: KeeperStateV3, ownerKeyConfigured: boolean): RecoveryDecisionV3 {
  if (!ownerKeyConfigured) return 'NONE';
  if (state.paused) return 'NONE';
  // Only the unsettled (entry/lock) shape is emergency-settle-eligible AND outcome-clean.
  if (state.phase !== PhaseViewV3.EntryOpen && state.phase !== PhaseViewV3.Locked) return 'NONE';
  // Must be at/past the settlement moment (a healthy epoch still in its window is not wedged).
  if (state.nowSec < state.settlementTime) return 'NONE';
  // The contract requires epochId == lastSettledEpochId + 1 == currentEpochId. Without a confirmed
  // lastSettledEpochId we can't prove the ordering, so we never risk a reverting owner tx.
  if (state.lastSettledEpochId === undefined) return 'NONE';
  if (state.currentEpochId !== state.lastSettledEpochId + 1n) return 'NONE';
  // Respect the on-chain grace: before it elapses, emergencySettle reverts - keep trying SETTLE.
  if (state.nowSec <= state.settlementTime + GRACE_SECONDS_V3) return 'WAIT_GRACE';
  return 'RECOVER';
}

/** Decide the single next action for a v3 market. PURE - no I/O, no clock read. */
export function decideActionV3(state: KeeperStateV3): ActionV3 {
  if (state.paused) return 'NONE';
  if (state.currentEpochId === 0n) return 'CREATE';

  switch (state.phase) {
    case PhaseViewV3.Idle:
      return 'OPEN';

    // EntryOpen and Locked are the same internal phase split by timestamp: nothing to
    // crank until the settlement moment, except draining any auto-return backlog left
    // on the PREVIOUS epoch during the wait.
    case PhaseViewV3.EntryOpen:
    case PhaseViewV3.Locked:
      if (state.nowSec >= state.settlementTime) return 'SETTLE';
      return hasUnstakeBacklogV3(state) ? 'UNSTAKE' : 'NONE';

    // Priced: drain the processing cursor, then finalize.
    case PhaseViewV3.Settling:
      return state.processedCursor < state.stakedCount ? 'PROCESS' : 'FINALIZE';

    // Settled: push the just-settled epoch's NFTs home FIRST, then start the next round.
    case PhaseViewV3.Settled:
      if (hasUnstakeBacklogV3(state)) return 'UNSTAKE';
      return 'CREATE';

    default:
      return 'NONE';
  }
}
