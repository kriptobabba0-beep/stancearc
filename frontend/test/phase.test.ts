import { describe, it, expect } from 'vitest';
import { PhaseView, Side, type EpochView, type StakeView } from '@/lib/types';
import { derivePhaseGate, phaseViewLabel } from '@/lib/phase';

// NOTE: the contract's EpochView field is `sweepCursor` (not `sweepCursorDone`) and carries
// startTimeActual/settleTimeActual — this builder mirrors the real decoded tuple exactly.
const baseEpoch = (over: Partial<EpochView>): EpochView => ({
  epochId: 1n, phase: PhaseView.Idle, entryOpenTime: 0n, entryCloseTime: 0n, startTime: 0n, endTime: 0n,
  startTimeActual: 0n, settleTimeActual: 0n,
  bandBps: 150, startPrice18: 0n, settlePrice18: 0n, deltaBps: 0n, winningSide: Side.NONE, rolledOver: false,
  stakedCount: 0, sweepCursor: 0, potWETH: 0n, potUSDC: 0n, sideContribution6: [0n, 0n, 0n, 0n],
  winnerDenominator: 0n, rolloverPendingIn: false, rolloverInWETH: 0n, rolloverInUSDC: 0n, ...over,
});
const baseStake = (over: Partial<StakeView>): StakeView => ({
  tokenId: 7n, owner: '0x0000000000000000000000000000000000000001', epochId: 1n, side: Side.UP,
  swept: false, claimed: false, unstaked: false, feeWETH: 0n, feeUSDC: 0n, contribution6: 0n, ...over,
});

describe('derivePhaseGate', () => {
  it('EntryOpen allows stake, hides projection', () => {
    const g = derivePhaseGate(baseEpoch({ phase: PhaseView.EntryOpen, stakedCount: 0 }));
    expect(g.canStake).toBe(true);
    expect(g.showProjection).toBe(false);
    expect(g.canClaim).toBe(false);
    expect(g.canUnstake).toBe(false);
  });
  it('Running: no stake, no claim, no projection', () => {
    const g = derivePhaseGate(baseEpoch({ phase: PhaseView.Running }));
    expect(g.canStake).toBe(false);
    expect(g.showProjection).toBe(false);
  });
  it('Settled + sweepDone + winner + !claimed => canClaim, showProjection', () => {
    const e = baseEpoch({ phase: PhaseView.Settled, stakedCount: 2, sweepCursor: 2, winningSide: Side.UP, rolledOver: false });
    const s = baseStake({ side: Side.UP, swept: true, claimed: false });
    const g = derivePhaseGate(e, s);
    expect(g.sweepDone).toBe(true);
    expect(g.canClaim).toBe(true);
    expect(g.canUnstake).toBe(true);
    expect(g.showProjection).toBe(true);
  });
  it('Settled but sweep incomplete => no claim', () => {
    const e = baseEpoch({ phase: PhaseView.Settled, stakedCount: 3, sweepCursor: 2, winningSide: Side.UP });
    const s = baseStake({ side: Side.UP, swept: false });
    const g = derivePhaseGate(e, s);
    expect(g.sweepDone).toBe(false);
    expect(g.canClaim).toBe(false);
    expect(g.canUnstake).toBe(false); // per-position swept gates unstake
  });
  it('Settled, rolledOver => no claim even for winner', () => {
    const e = baseEpoch({ phase: PhaseView.Settled, stakedCount: 1, sweepCursor: 1, winningSide: Side.UP, rolledOver: true });
    const s = baseStake({ side: Side.UP, swept: true });
    expect(derivePhaseGate(e, s).canClaim).toBe(false);
  });
  it('Settled, losing side => no claim, but can unstake when swept', () => {
    const e = baseEpoch({ phase: PhaseView.Settled, stakedCount: 1, sweepCursor: 1, winningSide: Side.DOWN });
    const s = baseStake({ side: Side.UP, swept: true });
    const g = derivePhaseGate(e, s);
    expect(g.canClaim).toBe(false);
    expect(g.canUnstake).toBe(true);
  });
  it('already claimed => no claim; already unstaked => no unstake', () => {
    const e = baseEpoch({ phase: PhaseView.Settled, stakedCount: 1, sweepCursor: 1, winningSide: Side.UP });
    expect(derivePhaseGate(e, baseStake({ side: Side.UP, swept: true, claimed: true })).canClaim).toBe(false);
    expect(derivePhaseGate(e, baseStake({ side: Side.UP, swept: true, unstaked: true })).canUnstake).toBe(false);
  });
});

describe('phaseViewLabel', () => {
  it('labels each PhaseView', () => {
    expect(phaseViewLabel(PhaseView.Idle)).toBe('Idle');
    expect(phaseViewLabel(PhaseView.EntryOpen)).toBe('Entry Open');
    expect(phaseViewLabel(PhaseView.Running)).toBe('Running');
    expect(phaseViewLabel(PhaseView.Settled)).toBe('Settled');
  });
});
