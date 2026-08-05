// decide.ts - the PURE decision function at the heart of the keeper.
//
// Given a snapshot of one market's current epoch, it returns the single next
// lifecycle action to take. It performs NO I/O and reads NO clock: `nowSec` is an
// input so it is trivially unit-testable across the whole state space.
//
// Phase semantics are the contract's external 4-phase collapse (PhaseView):
//   Idle=0, EntryOpen=1, Running=2, Settled=3
// where the internal 6-phase Running/Resolved/Swept all collapse to Running. We
// therefore distinguish them WITHIN Running via:
//   - settlePrice18 === 0n  -> not yet ended (internal Running)        -> END when due
//   - settlePrice18 !== 0n  -> ended/resolved (internal Resolved/Swept)
//       - sweepCursor < stakedCount -> still sweeping                  -> SWEEP
//       - sweepCursor === stakedCount -> fully swept                   -> FINALIZE
// (Verified against src/FeeArena.sol: startEpoch sets Phase.Running; endEpoch sets
//  settlePrice18 + Phase.Resolved; sweep advances sweepCursor and flips Swept when
//  cursor==stakedCount; finalizeSettle requires internal phase Swept. An empty epoch
//  - stakedCount 0 - STILL requires one sweep() call (Resolved->Swept) before
//  finalizeSettle() is allowed; the view collapses both Resolved-empty and Swept-empty
//  to cursor==0==stakedCount, so we track lastSweptEpochId to distinguish them.)

/** External 4-phase view, mirrors src/interfaces/IFeeArena.sol PhaseView. */
export enum PhaseView {
  Idle = 0,
  EntryOpen = 1,
  Running = 2,
  Settled = 3,
}

/**
 * The single next lifecycle action the keeper should take for a market this tick.
 * `STUCK` is a terminal, no-tx signal: the start window was missed (now >
 * entryCloseTime + maxStartDelay) so `startEpoch` would revert `StartDelayExceeded`
 * forever - only the owner's `emergencySettle` can clear it. The runner logs it
 * loudly and sends NO transaction.
 */
export type Action =
  | 'NONE'
  | 'CREATE'
  | 'OPEN'
  | 'START'
  | 'END'
  | 'SWEEP'
  | 'FINALIZE'
  | 'UNSTAKE'
  | 'STUCK';

/**
 * Minimal projection of a market's current epoch needed to decide the next action.
 * All on-chain numerics are kept as the natural decoded type: timestamps/prices are
 * bigint; cursor/count are number (uint32 -> number in the EpochView). `nowSec` is
 * the wall-clock used for the time-gated transitions (injected, never read here).
 */
export interface KeeperState {
  currentEpochId: bigint;
  phase: PhaseView;
  entryCloseTime: bigint;
  /**
   * The epoch's `startTime` (the boundary the v2 contract PINS the start price to). v1
   * never reads it (v1 starts on any fresh blob once entry closes), but it is sourced
   * uniformly from the epoch view so the v2 pinned-window logic (decideV2) can use it for
   * a START action. Harmless for v1 markets.
   */
  startTime: bigint;
  endTime: bigint;
  settlePrice18: bigint;
  sweepCursor: number;
  stakedCount: number;
  nowSec: bigint;
  /**
   * The contract's `maxStartDelay()` (seconds). `startEpoch` reverts
   * `StartDelayExceeded` once `now > entryCloseTime + maxStartDelay`, so the keeper
   * must not keep trying to START past that bound. NOT part of EpochView - read
   * separately from the public `maxStartDelay()` getter.
   */
  maxStartDelay: bigint;
  /**
   * The contract's `paused()`. While paused, every price-posting / settlement crank
   * is a guaranteed revert (`whenNotPaused`), so the keeper takes NO action.
   */
  paused: boolean;
  /**
   * The epochId for which a sweep() has already been confirmed successful this
   * runtime session (sourced from MarketRuntime.lastSweptEpochId). Used to
   * distinguish Resolved-empty (needs one sweep()) from Swept-empty (ready to
   * finalize) - the PhaseView cannot tell them apart since both collapse to Running
   * with cursor==0==stakedCount.
   * Null means no sweep has been recorded yet for any epoch in this session.
   */
  lastSweptEpochId: bigint | null;
  /**
   * v1 AUTO-RETURN (all three OPTIONAL - v2 markets and older tests omit them, which
   * disables the UNSTAKE action entirely). `lastSettledEpochId` is the contract's
   * `lastSettledEpochId()` (the most recently Settled epoch; 0n if none yet), and
   * `unstakeDone`/`unstakeTotal` mirror `unstakeProgress(lastSettledEpochId)`. When
   * done < total the settled epoch still holds escrowed NFTs to push back to their
   * owners via the permissionless `unstakeBatch`. Progress is FULLY on-chain (the
   * cursor), so unlike lastSweptEpochId no in-memory session tracking is needed and a
   * keeper restart can never re-issue a completed batch.
   */
  lastSettledEpochId?: bigint;
  unstakeDone?: number;
  unstakeTotal?: number;
}

/**
 * True when the most recently Settled epoch still has escrowed NFTs the auto-return
 * crank should push back (unstakeProgress done < total). False whenever the fields are
 * absent (v2 market, or a state built before the auto-return feature). PURE.
 */
export function hasUnstakeBacklog(state: KeeperState): boolean {
  return (
    state.lastSettledEpochId !== undefined &&
    state.lastSettledEpochId !== 0n &&
    state.unstakeDone !== undefined &&
    state.unstakeTotal !== undefined &&
    state.unstakeDone < state.unstakeTotal
  );
}

/**
 * Decide the single next lifecycle action for a market given its current state.
 * PURE - total over the state space, no I/O, no clock read.
 */
export function decideAction(state: KeeperState): Action {
  // Paused: every payable/settlement crank reverts under `whenNotPaused`, and the
  // permissioned cranks are pointless while halted - take no action at all.
  if (state.paused) return 'NONE';

  // Never created (no epoch slot yet) -> bootstrap the first epoch.
  if (state.currentEpochId === 0n) return 'CREATE';

  switch (state.phase) {
    // Created but entry not yet opened (internal Phase.None). Open it.
    case PhaseView.Idle:
      return 'OPEN';

    // Entry window: only start once entry has closed; until then, wait. But if the
    // bounded start window has fully elapsed (now > entryCloseTime + maxStartDelay),
    // `startEpoch` would revert `StartDelayExceeded` on every tick - the epoch is
    // WEDGED and only the owner's `emergencySettle` can clear it. Signal STUCK so the
    // runner alerts and sends NO tx.
    case PhaseView.EntryOpen:
      if (state.nowSec > state.entryCloseTime + state.maxStartDelay) return 'STUCK';
      if (state.nowSec >= state.entryCloseTime) return 'START';
      // Waiting for entry to close - a time-idle tick. Use it to drain any auto-return
      // backlog left on the PREVIOUS settled epoch (e.g. after keeper downtime).
      return hasUnstakeBacklog(state) ? 'UNSTAKE' : 'NONE';

    // Collapsed Running covers internal Running / Resolved / Swept.
    case PhaseView.Running:
      if (state.settlePrice18 === 0n) {
        // Not yet ended (internal Running): end once past endTime, else wait - and use
        // the wait, like EntryOpen above, to drain any auto-return backlog.
        if (state.nowSec >= state.endTime) return 'END';
        return hasUnstakeBacklog(state) ? 'UNSTAKE' : 'NONE';
      }
      // Ended/resolved: drain the sweep, then finalize.
      // Non-empty epoch: advance cursor until cursor==stakedCount, then finalize.
      if (state.sweepCursor < state.stakedCount) return 'SWEEP';
      // Empty epoch (stakedCount==0): the contract still requires ONE sweep() call to
      // transition internal phase Resolved->Swept before finalizeSettle() is allowed.
      // cursor(0)==total(0) can't distinguish Resolved-empty from Swept-empty via the
      // view, so we track whether we've already swept this epoch via lastSweptEpochId.
      if (state.stakedCount === 0 && state.lastSweptEpochId !== state.currentEpochId) {
        return 'SWEEP';
      }
      return 'FINALIZE';

    // Settled: push the just-settled epoch's NFTs back to their owners FIRST (the
    // auto-return the user experiences as "my stake came back when the round ended"),
    // then begin the next epoch. unstakeBatch is permissionless + cursor-resumable, so
    // each tick advances one bounded batch until done==total, after which CREATE runs.
    case PhaseView.Settled:
      if (hasUnstakeBacklog(state)) return 'UNSTAKE';
      return 'CREATE';

    default:
      return 'NONE';
  }
}

// ===========================================================================
// OPTIONAL owner-key wedge auto-recovery (testnet operational convenience).
//
// When the keeper detects a wedged epoch (decideAction === 'STUCK': an
// unresolved EntryOpen/Running epoch whose start window has irrecoverably
// lapsed, so `startEpoch` reverts `StartDelayExceeded` forever), the ONLY
// on-chain exit is `FeeArena.emergencySettle(epochId, resolution)`, which is
// `onlyOwner`. The restricted keeper key cannot call it, so without an owner
// key a human must intervene every time the keeper is down across a start
// window. If an OPTIONAL owner key is configured, the keeper can self-heal by
// calling emergencySettle with a SEPARATE owner signer.
//
// This pure decision says WHETHER recovery should fire this tick - it never
// signs or sends. The runner (keeper.ts) gates the owner wallet behind it.
//
// IMPORTANT (mainnet): an always-loaded hot owner key is a TESTNET convenience
// ONLY. On mainnet, recovery should be guarded/manual/multisig - keep the
// owner key cold and run emergencySettle by hand. See README.
// ===========================================================================

/**
 * The on-chain GRACE window (seconds) FeeArena enforces before emergencySettle
 * is allowed: it reverts `GraceNotElapsed` while `block.timestamp <= endTime +
 * GRACE`. Mirrors `FeeArena.GRACE` (verified against src/FeeArena.sol: 600s).
 * The keeper uses it to avoid spamming emergencySettle before grace elapses.
 */
export const GRACE_SECONDS = 600n;

/**
 * The `Side` resolution passed to emergencySettle for a wedged (never-started)
 * epoch. RANGE=3 is the neutral outcome - emergencySettle rolls the realized
 * pot forward into the global rollover regardless of resolution, so RANGE keeps
 * recovery outcome-neutral. Mirrors FeeArena's Side enum (RANGE == 3).
 */
export const EMERGENCY_RESOLUTION_RANGE = 3;

/**
 * The recovery decision for a wedged epoch when an owner key is available:
 *   - 'RECOVER'    - genuinely wedged, grace elapsed: call emergencySettle now.
 *   - 'WAIT_GRACE' - genuinely wedged, but block.timestamp <= endTime + GRACE:
 *                    emergencySettle would revert GraceNotElapsed; back off and
 *                    retry on a later tick (do NOT spam it every tick).
 *   - 'NONE'       - NOT a recovery situation (epoch not wedged, already
 *                    resolved (settlePrice18 != 0), already Settled, or no owner
 *                    key): take no recovery action. The owner key path is
 *                    impossible to trigger here by construction.
 */
export type RecoveryDecision = 'RECOVER' | 'WAIT_GRACE' | 'NONE';

/**
 * Decide whether the owner key should run emergencySettle for a wedged epoch.
 * PURE - no I/O, no clock read (nowSec is in `state`).
 *
 * Recovery fires ONLY when ALL of these hold (every condition the contract's
 * emergencySettle itself enforces, checked here so we never send a doomed tx):
 *   1. An owner key is configured (`ownerKeyConfigured`). Absent => 'NONE',
 *      preserving the exact pre-existing detect→STUCK behavior.
 *   2. decideAction(state) === 'STUCK' - the SAME wedge signal already surfaced
 *      today (EntryOpen, start window missed). This guarantees the owner path
 *      can never trigger on a healthy epoch or any normal crank.
 *   3. settlePrice18 === 0n - genuinely unresolved (endEpoch never ran). A
 *      resolved epoch can be driven to Settled via sweep+finalize, so we must
 *      never emergencySettle it (it would also revert WrongPhase).
 *   4. phase is EntryOpen/Running (NOT Settled/None) - implied by (2) returning
 *      STUCK only from EntryOpen, but checked explicitly for safety.
 * If wedged+eligible but grace has NOT elapsed (nowSec <= endTime + GRACE),
 * returns 'WAIT_GRACE' so the runner backs off instead of spamming a tx that
 * would revert GraceNotElapsed.
 */
export function decideRecovery(state: KeeperState, ownerKeyConfigured: boolean): RecoveryDecision {
  // No owner key => behavior is UNCHANGED: never attempt recovery.
  if (!ownerKeyConfigured) return 'NONE';

  // Recovery is gated on the EXACT wedge signal decideAction already emits. This
  // is the single source of truth for "wedged" and keeps the owner path provably
  // unreachable for any non-STUCK state (healthy, paused, normal crank, etc.).
  if (decideAction(state) !== 'STUCK') return 'NONE';

  // Defense-in-depth: re-check the contract's own emergencySettle preconditions so
  // we never sign a tx that is guaranteed to revert. A STUCK action only arises
  // from EntryOpen with settlePrice18==0, but assert both explicitly.
  if (state.settlePrice18 !== 0n) return 'NONE';
  if (state.phase === PhaseView.Settled || state.phase === PhaseView.Idle) return 'NONE';

  // Respect the on-chain GRACE window: emergencySettle reverts GraceNotElapsed
  // while now <= endTime + GRACE. Wait and retry later instead of spamming.
  if (state.nowSec <= state.endTime + GRACE_SECONDS) return 'WAIT_GRACE';

  return 'RECOVER';
}
