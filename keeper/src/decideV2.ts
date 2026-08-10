// decideV2.ts — the PURE timing core for the FeeArena **v2** (PINNED) settle path.
//
// It ALSO carries the pure `collapseV2Phase` helper (the v2 read-path phase fix): v2's
// `currentEpoch()` returns the RAW 6-phase internal `Phase` enum (it does NOT run
// EpochViewLib.toView/collapse the way v1's `currentEpoch()` does), so the keeper MUST
// collapse it to the external 4-phase `PhaseView` before feeding decideAction — see below.
//
// v2 differs from v1 ONLY at startEpoch/endEpoch. The contract no longer trusts the
// cranker to choose the print: FeeArenaV2._pinnedFetch forces the posted Hermes blob's
// publishTime into a NARROW window chosen BY THE CONTRACT:
//   - startEpoch: [startTime, startTime + settleWindow]
//   - endEpoch:   [endTime,   endTime   + settleWindow]
// via the oracle's getPinnedPrice -> pyth.parsePriceFeedUpdates, which REVERTS
// (PriceFeedNotFoundWithinRange) unless the blob lands in [min,max]. settleWindow is
// owner-set, default ~12s, HARD-CAPPED at MAX_SETTLE_WINDOW (60s) by the contract.
//
// The keeper therefore can no longer post "any fresh update once the endpoint passes"
// (the v1 behavior). It must crank PROMPTLY after the endpoint with a blob whose
// publishTime is still inside the window. Pyth's latest update advances continuously
// (~sub-second cadence on Hermes), so a freshly-fetched blob has publishTime ~= now;
// the keeper must thus ATTEMPT the pinned crank only while the wall-clock sits inside
// the window, leaving a safety margin at the TAIL for the blob's own latency plus the
// fetch->broadcast->mine delay. This module is the pure, total, clock-free decision
// for WHEN that attempt is valid — unit-testable across the whole window.
//
// CRITICAL TIMING (quantified): with settleWindow=12s and POLL_INTERVAL_MS=15s, a single
// poll could step right OVER the entire 12s window and never attempt — wedging the epoch.
// The runner (keeper.ts) MUST poll a v2 market faster than the window while it is near an
// endpoint. See keeper.ts: a v2 market in the WAIT/ATTEMPT zone uses a tight sub-window
// re-check cadence; index.ts caps a v2 market's effective poll at <= settleWindow/2.

import { PhaseView } from './decide.js';

/** Hard cap on the pin window, mirrors FeeArenaV2.MAX_SETTLE_WINDOW (60s). */
export const MAX_SETTLE_WINDOW = 60n;

/**
 * The INTERNAL 6-phase machine the v2 contract stores per epoch (mirrors
 * src/interfaces/IFeeArena.sol `enum Phase`). v2's `currentEpoch()` returns the RAW
 * `EpochV2` struct (src/FeeArenaV2.sol :1083 — `return epochs[currentEpochId];`), so the
 * keeper reads THIS enum, NOT the external collapsed `PhaseView`. (v1's `currentEpoch()`
 * runs EpochViewLib.toView -> collapse, so v1 already hands back the 4-phase PhaseView and
 * MUST NOT be collapsed again.)
 */
export enum PhaseV2 {
  None = 0,
  EntryOpen = 1,
  Running = 2,
  Resolved = 3,
  Swept = 4,
  Settled = 5,
}

/**
 * Collapse the v2 contract's RAW 6-phase internal `Phase` to the external 4-phase
 * `PhaseView` that decideAction consumes. This mirrors `EpochViewLib.collapse`
 * (src/libraries/EpochViewLib.sol) EXACTLY — it is the ONLY external phase semantics:
 *
 *   None(0)      -> Idle(0)
 *   EntryOpen(1) -> EntryOpen(1)
 *   Running(2)   -> Running(2)
 *   Resolved(3)  -> Running(2)   (sweep in progress; claim/unstake still closed)
 *   Swept(4)     -> Running(2)   (denominator not yet frozen)
 *   Settled(5)   -> Settled(3)   (claim + unstake OPEN)
 *
 * decideAction already distinguishes internal Running/Resolved/Swept WITHIN the collapsed
 * `Running` view via settlePrice18 + sweepCursor/stakedCount (same way it does for v1), so
 * collapsing the 6 raw phases to 4 makes the v2 read path behave identically to v1's.
 *
 * CRITICAL: without this, the keeper read path did `Number(epoch.phase) as PhaseView` on the
 * raw v2 enum, so a v2 epoch in Resolved(3) was misread as PhaseView.Settled(3) -> decideAction
 * computed CREATE -> createEpoch reverts PrevNotSettled, winners never paid; Swept(4) fell into
 * the `default` -> NONE (never FINALIZE); Settled(5) was out of the PhaseView range -> NONE
 * (next epoch never created). The v2 lifecycle permanently wedged at first settle.
 *
 * PURE — total over `number` input. An unknown/out-of-range value (a misread that is neither a
 * valid Phase nor PhaseView) defaults to Running, the safe "settlement in progress" bucket, so
 * a transient bad read never spuriously CREATEs or stalls.
 */
export function collapseV2Phase(rawPhase: number): PhaseView {
  switch (rawPhase) {
    case PhaseV2.None:
      return PhaseView.Idle;
    case PhaseV2.EntryOpen:
      return PhaseView.EntryOpen;
    case PhaseV2.Settled:
      return PhaseView.Settled;
    // Running, Resolved, Swept all surface as Running (and so does any unexpected value —
    // the conservative bucket that never triggers CREATE on a misread).
    case PhaseV2.Running:
    case PhaseV2.Resolved:
    case PhaseV2.Swept:
    default:
      return PhaseView.Running;
  }
}

/**
 * The keeper's default safety margin (seconds) shaved off the window TAIL. A fresh Hermes
 * blob's publishTime is ~= now, and a few hundred ms to a couple seconds elapse between
 * fetching it and the tx being mined. Attempting in the last `safetyMarginSec` of the
 * window risks the blob's publishTime (or a slightly newer re-fetch) landing PAST
 * endpoint+settleWindow -> parsePriceFeedUpdates reverts. 2s is a conservative default for
 * a ~12s window (leaves ~10s of attemptable runway). Configurable via KEEPER_V2_WINDOW_MARGIN_SEC.
 *
 * TUNING (LIVENESS): this 2s default assumes Hermes-fetch + broadcast + mine latency stays
 * well under ~2s. If the keeper repeatedly logs `windowState:'MISSED'` (and now the distinct
 * `PINNED WINDOW repeatedly MISSED` alert fires — see index.ts), the real fetch->mine latency
 * is eating into the tail: WIDEN this margin (e.g. KEEPER_V2_WINDOW_MARGIN_SEC=3..4) and/or
 * raise the on-chain `settleWindow` so the attemptable runway comfortably exceeds measured
 * latency. The default is left at 2s to keep the widest attemptable runway on a healthy
 * ~12s window; the repeated-MISSED alert is the signal to raise it for a slower chain/RPC.
 */
export const DEFAULT_V2_WINDOW_MARGIN_SEC = 2n;

/**
 * The decision for a single pinned endpoint (start or end) this tick:
 *   - 'WAIT'    — the endpoint has NOT passed yet (now < endpointTime). Posting now would
 *                 revert out-of-window (publishTime < minPub). Do nothing; re-check soon.
 *   - 'ATTEMPT' — now is inside [endpointTime, endpointTime+settleWindow-margin]; a fresh
 *                 blob's publishTime should land in-window. Fetch + post.
 *   - 'MISSED'  — now is past the safe tail (> endpointTime+settleWindow-margin). The window
 *                 is (nearly) closed; a post is likely to revert. Skip this tick — a fresher
 *                 blob on a faster sub-window re-check might still make it, but once the HARD
 *                 end (endpointTime+settleWindow) passes the epoch can only be cleared by the
 *                 owner's emergencySettle. The runner ALERTs on repeated MISSED.
 */
export type PinnedWindowDecision = 'WAIT' | 'ATTEMPT' | 'MISSED';

/**
 * Clamp a settleWindow read from the arena to the SAFE, sane range the contract guarantees:
 * 1..MAX_SETTLE_WINDOW. The contract enforces 0 < settleWindow <= 60 at its config setters,
 * so a value outside that is a misread (RPC hiccup / wrong ABI) — clamp defensively rather
 * than trust it: cap at 60 so we never over-extend the attemptable window, and floor at 1 so
 * a 0 read doesn't collapse the window to nothing. PURE.
 */
export function effectiveSettleWindow(settleWindow: bigint): bigint {
  if (settleWindow < 1n) return 1n;
  if (settleWindow > MAX_SETTLE_WINDOW) return MAX_SETTLE_WINDOW;
  return settleWindow;
}

/**
 * Decide whether to attempt a pinned start/end crank this tick. PURE — total over the
 * input space, no I/O, no clock read (`nowSec` is injected).
 *
 * The HARD window the contract enforces is [endpointTime, endpointTime+settleWindow]
 * (inclusive). We attempt only within [endpointTime, lastSafe] where
 *   lastSafe = max(endpointTime, endpointTime + settleWindow - safetyMarginSec).
 * The `max(endpointTime, ...)` guard means a margin >= the window never pushes lastSafe
 * before the endpoint — the endpoint instant is ALWAYS attemptable (so a tiny window with
 * a generous margin degrades to "attempt at the endpoint" rather than "never attempt").
 *
 * @param p.nowSec          wall-clock seconds (injected; the runner passes Date.now()/1000).
 * @param p.endpointTime    the epoch boundary the contract pins to (startTime for START,
 *                          endTime for END).
 * @param p.settleWindow    the contract's settleWindow (already clamped via
 *                          effectiveSettleWindow by the caller, but re-clamped here too).
 * @param p.safetyMarginSec seconds shaved off the window tail for blob + mine latency.
 */
export function decidePinnedWindow(p: {
  nowSec: bigint;
  endpointTime: bigint;
  settleWindow: bigint;
  safetyMarginSec: bigint;
}): PinnedWindowDecision {
  const win = effectiveSettleWindow(p.settleWindow);
  if (p.nowSec < p.endpointTime) return 'WAIT';

  const hardEnd = p.endpointTime + win;
  // Shave the tail by the margin, but never before the endpoint itself.
  const margin = p.safetyMarginSec < 0n ? 0n : p.safetyMarginSec;
  let lastSafe = hardEnd - margin;
  if (lastSafe < p.endpointTime) lastSafe = p.endpointTime;

  return p.nowSec <= lastSafe ? 'ATTEMPT' : 'MISSED';
}
