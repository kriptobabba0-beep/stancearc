// decideAgent.ts - the PURE policy engine at the heart of the Limen Agent's ACT layer.
//
// The agent may enter an epoch ONLY when every clause of the human-approved mandate holds.
// This mirrors the field set of Circle Agent Wallet spending policies (caps, allowlists,
// time bounds) so the same mandate maps onto wallet-layer enforcement when that becomes
// available on Arc mainnet - until then, THIS engine is the enforcement, and it fails
// CLOSED: any missing/degenerate input is a SKIP with a reason, never an action.
//
// PURE - no I/O, no clock reads (nowSec injected), trivially unit-testable.

import type { StanceView } from './agentQuant.js';

/** The human-approved mandate the agent operates under. Parsed from LIMEN_AGENT_POLICY. */
export interface AgentPolicy {
  /** Views the agent is allowed to take (e.g. the human may forbid DOWN). */
  allowedViews: StanceView[];
  /** Don't act below this estimated qualification probability (0..1). */
  minConfidence: number;
  /** Hard end of the mandate (unix seconds) - after this the agent stands down. */
  expiresAtSec: number;
  /** Skip when less than this remains of the entry window (no last-second entries). */
  minEntryLeftSec: number;
  /** The LP mint's quote-leg budget cap (raw 6dp USDC) - sized once at mint. */
  maxStakeUsdc6: bigint;
}

export type AgentVerdict =
  | { act: true; view: StanceView; side: 1 | 2 | 3 }
  | { act: false; reason: string };

const SIDE_OF: Record<StanceView, 1 | 2 | 3> = { UP: 1, DOWN: 2, RANGE: 3 };

/** PhaseView.EntryOpen in the v3 arena. */
const PHASE_ENTRY_OPEN = 1;

/** Decide whether the agent may enter the CURRENT epoch, and on which side. PURE. */
export function decideAgentEntry(input: {
  policy: AgentPolicy;
  nowSec: number;
  phase: number;
  entryCloseTime: bigint;
  alreadyActedThisEpoch: boolean;
  signal: { view: StanceView; confidence: number } | null;
}): AgentVerdict {
  const { policy, nowSec, phase, entryCloseTime, alreadyActedThisEpoch, signal } = input;

  if (nowSec >= policy.expiresAtSec) {
    return { act: false, reason: 'mandate expired - renew LIMEN_AGENT_POLICY.expiresAtSec to continue' };
  }
  if (phase !== PHASE_ENTRY_OPEN) {
    return { act: false, reason: `entry is not open (phase ${phase})` };
  }
  const entryLeft = Number(entryCloseTime) - nowSec;
  if (entryLeft < policy.minEntryLeftSec) {
    return { act: false, reason: `only ${entryLeft}s left in the entry window (< ${policy.minEntryLeftSec}s floor)` };
  }
  if (alreadyActedThisEpoch) {
    return { act: false, reason: 'already entered this epoch (once per epoch)' };
  }
  if (signal === null) {
    return { act: false, reason: 'no signal - not enough recent price data to estimate' };
  }
  if (!policy.allowedViews.includes(signal.view)) {
    return { act: false, reason: `signal says ${signal.view} but the mandate does not allow it` };
  }
  if (!(signal.confidence >= policy.minConfidence)) {
    return {
      act: false,
      reason: `confidence ${(signal.confidence * 100).toFixed(0)}% below the ${(policy.minConfidence * 100).toFixed(0)}% mandate floor`,
    };
  }
  return { act: true, view: signal.view, side: SIDE_OF[signal.view] };
}
