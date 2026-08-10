// lib/agent/autopilot.ts — the assisted autopilot's decision core (pure, unit-tested).
//
// The autopilot watches epochs while the Agent page is open and PROPOSES an entry when the
// odds clear the user's confidence floor — the user confirms every transaction, exactly like
// a chat-proposed action. This is the consent-first slice of the mandate agent: same signal,
// same once-per-epoch discipline, no delegated signing. (Unattended entry — signing without
// the user present — is the Agent-Wallet-per-user rail, milestone M3.)

export type StanceView = 'UP' | 'DOWN' | 'RANGE';

export interface AutopilotInput {
  /** Arena phase (1 = entry open). */
  phase: number;
  epochId: string;
  entryLeftSec: number;
  /** The last epoch this autopilot already evaluated to completion (proposed or passed). */
  lastHandledEpochId: string | null;
  /** Full outcome odds — the decision picks the best view WITHIN the mandate. */
  signal: { pUp: number; pDown: number; pRange: number } | null;
  minConfidence: number;
  /** The mandate's allowed views — the CANDIDATE SET the decision chooses from. */
  allowedViews?: StanceView[];
  /** Don't propose with less than this left — the user needs time to confirm. */
  minEntryLeftSec?: number;
}

export type AutopilotDecision =
  | { act: 'propose'; side: StanceView; confidence: number; markHandled: true }
  | { act: 'skip'; reason: string; markHandled: boolean };

/**
 * The strongest view the mandate ALLOWS, with its probability. The mandate is a FILTER on
 * what the agent may do — never a veto keyed to the global favorite. A user who allows only
 * UP/DOWN is asking for "the better of UP and DOWN, whenever it clears MY floor", even while
 * RANGE leads globally. (Field case: RANGE at 80% + a mandate of UP/DOWN froze the autopilot
 * on "waiting for it to flip" — deliberately betting the underdog sides at a 10% floor is
 * the user's call to make, and the old logic made it impossible.)
 */
export function bestAllowedView(
  signal: { pUp: number; pDown: number; pRange: number },
  allowedViews?: StanceView[],
): { view: StanceView; p: number } {
  const allowed = allowedViews === undefined || allowedViews.length === 0 ? ALL_VIEWS : allowedViews;
  const all: { view: StanceView; p: number }[] = [
    { view: 'UP', p: signal.pUp },
    { view: 'DOWN', p: signal.pDown },
    { view: 'RANGE', p: signal.pRange },
  ];
  const candidates = all.filter((c) => allowed.includes(c.view));
  return candidates.reduce((a, b) => (b.p > a.p ? b : a));
}
const ALL_VIEWS: StanceView[] = ['UP', 'DOWN', 'RANGE'];

export function decideAutopilot(input: AutopilotInput): AutopilotDecision {
  const minLeft = input.minEntryLeftSec ?? 30;
  if (input.phase !== 1) return { act: 'skip', reason: 'entry is not open', markHandled: false };
  if (input.lastHandledEpochId === input.epochId) {
    return { act: 'skip', reason: 'already handled this epoch', markHandled: false };
  }
  if (input.entryLeftSec < minLeft) {
    // Too late to confirm safely — close out this epoch and wait for the next.
    return { act: 'skip', reason: 'not enough entry time left to confirm', markHandled: true };
  }
  if (input.signal === null) return { act: 'skip', reason: 'no signal yet', markHandled: false };
  const best = bestAllowedView(input.signal, input.allowedViews);
  if (best.p < input.minConfidence) {
    // Below the floor NOW — odds sharpen as settlement nears, so keep re-evaluating.
    return {
      act: 'skip',
      reason: `best allowed view ${best.view} at ${(best.p * 100).toFixed(0)}% — below the ${(input.minConfidence * 100).toFixed(0)}% floor`,
      markHandled: false,
    };
  }
  return { act: 'propose', side: best.view, confidence: best.p, markHandled: true };
}
