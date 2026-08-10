// epochV2.test.ts — the raw EpochV2 -> EpochView adapter (lib/epochV2.ts).
//
// The v2 arena's currentEpoch()/getEpoch() return the RAW EpochV2 struct (NOT the v1 collapsed
// EpochView): a raw 6-phase Phase (None=0,EntryOpen=1,Running=2,Resolved=3,Swept=4,Settled=5), NO
// epochId field (read separately via currentEpochId()), and reordered/extra conviction fields. The
// adapter collapses the 6-phase Phase to the 4-phase PhaseView, injects epochId, and maps the v2
// fields into the EpochView shape the EpochPanel/SideBars consume. It MUST be pure + framework-free.
import { describe, it, expect } from 'vitest';
import { adaptEpochV2, RawPhase, type RawEpochV2 } from '@/lib/epochV2';
import { PhaseView, Side } from '@/lib/types';

// A representative raw EpochV2 tuple (decoded as a named object by viem). Field order/names mirror
// the abis/feeArenaV2.ts currentEpoch tuple exactly.
function rawEpoch(overrides: Partial<RawEpochV2> = {}): RawEpochV2 {
  return {
    phase: RawPhase.Running,
    entryOpenTime: 10n,
    entryCloseTime: 100n,
    startTime: 130n,
    endTime: 430n,
    startTimeActual: 131n,
    settleTimeActual: 0n,
    winningSide: Side.NONE,
    rolledOver: false,
    rolloverConsumed: false,
    sweepCursor: 0,
    stakedCount: 3,
    bandBps: 150,
    startPrice18: 3000_000000000000000000n,
    settlePrice18: 0n,
    deltaBps: 0n,
    potWETH: 7n,
    potUSDC: 11n,
    sideContribution6: [0n, 1n, 2n, 3n] as const,
    winnerDenominator: 0n,
    claimedWETH: 0n,
    claimedUSDC: 0n,
    claimedCount: 0,
    subsidyUSDC: 500_000000n,
    sideConviction: [0n, 100n, 200n, 300n] as const,
    winnerSqrtConvSum: 0n,
    winningConvictionSum: 0n,
    refundedConviction: 0n,
    convRefundedCount: 0,
    burnedConviction: 0n,
    ...overrides,
  };
}

describe('adaptEpochV2 — phase collapse (6-phase Phase -> 4-phase PhaseView)', () => {
  it('None -> Idle', () => {
    expect(adaptEpochV2(rawEpoch({ phase: RawPhase.None }), 5n).phase).toBe(PhaseView.Idle);
  });
  it('EntryOpen -> EntryOpen', () => {
    expect(adaptEpochV2(rawEpoch({ phase: RawPhase.EntryOpen }), 5n).phase).toBe(PhaseView.EntryOpen);
  });
  it('Running -> Running', () => {
    expect(adaptEpochV2(rawEpoch({ phase: RawPhase.Running }), 5n).phase).toBe(PhaseView.Running);
  });
  it('Resolved -> Running', () => {
    expect(adaptEpochV2(rawEpoch({ phase: RawPhase.Resolved }), 5n).phase).toBe(PhaseView.Running);
  });
  it('Swept -> Running', () => {
    expect(adaptEpochV2(rawEpoch({ phase: RawPhase.Swept }), 5n).phase).toBe(PhaseView.Running);
  });
  it('Settled -> Settled', () => {
    expect(adaptEpochV2(rawEpoch({ phase: RawPhase.Settled }), 5n).phase).toBe(PhaseView.Settled);
  });
  it('accepts a bigint phase (viem may decode a uint8 enum to bigint)', () => {
    expect(adaptEpochV2(rawEpoch({ phase: 5n as unknown as RawPhase }), 5n).phase).toBe(PhaseView.Settled);
  });
});

describe('adaptEpochV2 — epochId injection + field mapping', () => {
  it('injects the epochId (raw struct has no epochId field)', () => {
    expect(adaptEpochV2(rawEpoch(), 42n).epochId).toBe(42n);
  });

  it('maps the timing + price + pot fields straight through', () => {
    const v = adaptEpochV2(rawEpoch(), 1n);
    expect(v.entryOpenTime).toBe(10n);
    expect(v.entryCloseTime).toBe(100n);
    expect(v.startTime).toBe(130n);
    expect(v.endTime).toBe(430n);
    expect(v.startTimeActual).toBe(131n);
    expect(v.settleTimeActual).toBe(0n);
    expect(v.bandBps).toBe(150);
    expect(v.startPrice18).toBe(3000_000000000000000000n);
    expect(v.settlePrice18).toBe(0n);
    expect(v.deltaBps).toBe(0n);
    expect(v.potWETH).toBe(7n);
    expect(v.potUSDC).toBe(11n);
    expect(v.stakedCount).toBe(3);
    expect(v.sweepCursor).toBe(0);
    expect(v.winnerDenominator).toBe(0n);
  });

  it('maps sideContribution6 (the per-side depth bars source) verbatim', () => {
    expect(adaptEpochV2(rawEpoch(), 1n).sideContribution6).toEqual([0n, 1n, 2n, 3n]);
  });

  it('passes the winningSide + rolledOver flags straight through', () => {
    const v = adaptEpochV2(rawEpoch({ winningSide: Side.UP, rolledOver: true }), 1n);
    expect(v.winningSide).toBe(Side.UP);
    expect(v.rolledOver).toBe(true);
  });

  it('defaults the v1-only rollover-IN fields (absent in EpochV2) to false/0', () => {
    const v = adaptEpochV2(rawEpoch(), 1n);
    expect(v.rolloverPendingIn).toBe(false);
    expect(v.rolloverInWETH).toBe(0n);
    expect(v.rolloverInUSDC).toBe(0n);
  });

  it('exposes the v2-specific conviction fields (subsidyUSDC / sideConviction / winnerSqrtConvSum)', () => {
    const v = adaptEpochV2(rawEpoch(), 1n);
    expect(v.subsidyUSDC).toBe(500_000000n);
    expect(v.sideConviction).toEqual([0n, 100n, 200n, 300n]);
    expect(v.winnerSqrtConvSum).toBe(0n);
  });

  it('coerces numeric int32/uint32 fields decoded as bigint to number', () => {
    const v = adaptEpochV2(
      rawEpoch({
        bandBps: 150n as unknown as number,
        stakedCount: 3n as unknown as number,
        sweepCursor: 1n as unknown as number,
      }),
      1n,
    );
    expect(v.bandBps).toBe(150);
    expect(v.stakedCount).toBe(3);
    expect(v.sweepCursor).toBe(1);
  });

  it('accepts a positionally-decoded raw tuple (array) and produces the same EpochView', () => {
    // viem decodes named tuples to objects, but guard against an array decode as well.
    const obj = rawEpoch({ phase: RawPhase.Settled, winningSide: Side.DOWN });
    const arr = [
      obj.phase, obj.entryOpenTime, obj.entryCloseTime, obj.startTime, obj.endTime,
      obj.startTimeActual, obj.settleTimeActual, obj.winningSide, obj.rolledOver, obj.rolloverConsumed,
      obj.sweepCursor, obj.stakedCount, obj.bandBps, obj.startPrice18, obj.settlePrice18, obj.deltaBps,
      obj.potWETH, obj.potUSDC, obj.sideContribution6, obj.winnerDenominator, obj.claimedWETH,
      obj.claimedUSDC, obj.claimedCount, obj.subsidyUSDC, obj.sideConviction, obj.winnerSqrtConvSum,
      obj.winningConvictionSum, obj.refundedConviction, obj.convRefundedCount, obj.burnedConviction,
    ] as const;
    const v = adaptEpochV2(arr as unknown as RawEpochV2, 9n);
    expect(v.epochId).toBe(9n);
    expect(v.phase).toBe(PhaseView.Settled);
    expect(v.winningSide).toBe(Side.DOWN);
    expect(v.sideContribution6).toEqual([0n, 1n, 2n, 3n]);
  });
});
