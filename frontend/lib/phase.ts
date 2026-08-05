// lib/phase.ts - phase gating predicates. Gate on contract PhaseView + per-position StakeView flags,
// NEVER the client clock. showProjection is false until Settled (approved decision #5).
// NOTE: EpochView's swept-progress field is `sweepCursor` (matches the artifact, not `sweepCursorDone`).
import { PhaseView, Side, type EpochView, type StakeView, type PhaseGate } from '@/lib/types';

export function phaseViewLabel(phase: PhaseView): string {
  switch (phase) {
    case PhaseView.Idle: return 'Idle';
    case PhaseView.EntryOpen: return 'Entry Open';
    case PhaseView.Running: return 'Running';
    case PhaseView.Settled: return 'Settled';
    default: return 'Unknown';
  }
}

/** Derive the per-phase capability gate from an epoch + (optional) one of the caller's positions. */
export function derivePhaseGate(epoch: EpochView, stake?: StakeView): PhaseGate {
  const sweepDone = epoch.stakedCount > 0
    ? epoch.sweepCursor === epoch.stakedCount
    : epoch.phase === PhaseView.Settled; // zero-staker epoch is trivially swept once Settled
  const settled = epoch.phase === PhaseView.Settled;
  const isWinner = !!stake && settled && stake.side === epoch.winningSide && epoch.winningSide !== Side.NONE;

  return {
    canStake: epoch.phase === PhaseView.EntryOpen,
    canClaim: settled && !epoch.rolledOver && sweepDone && isWinner && !!stake && !stake.claimed,
    canUnstake: settled && !!stake && stake.swept && !stake.unstaked,
    showProjection: settled,
    sweepDone,
  };
}
