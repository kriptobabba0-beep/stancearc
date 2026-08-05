// lib/epochV2.ts - RAW EpochV2 -> EpochView adapter (FeeArena **v2** read layer).
//
// The v2 arena's currentEpoch()/getEpoch() return the RAW EpochV2 struct, NOT the v1 collapsed
// EpochView. It differs from EpochView in three load-bearing ways:
//   1. PHASE - a RAW 6-phase enum (None=0, EntryOpen=1, Running=2, Resolved=3, Swept=4, Settled=5).
//      The UI (EpochPanel/PhaseBadge/usePollInterval) speaks the 4-phase PhaseView, so we COLLAPSE:
//        None -> Idle, EntryOpen -> EntryOpen, Running/Resolved/Swept -> Running, Settled -> Settled.
//      (Mirrors IFeeArena.PhaseView + EpochViewLib in src/interfaces/IFeeArena.sol.)
//   2. NO epochId field - the raw struct omits it; the caller reads currentEpochId() (or already knows
//      the id for getEpoch(id)) and we INJECT it here.
//   3. REORDERED + EXTRA fields - winningSide/rolledOver/sweepCursor/stakedCount/bandBps are moved, and
//      v2 adds conviction-parimutuel fields (subsidyUSDC, sideConviction[4], winnerSqrtConvSum,
//      winningConvictionSum, burnedConviction, claimed*, refunded*). The raw struct has NO rollover-IN
//      fields (rolloverPendingIn/In*), so those EpochView fields default to false/0n.
//
// Output is an `EpochV2View`: a structural superset of EpochView (so every existing EpochView consumer
// - EpochPanel, SideBars, boundaryFor, usePollInterval - works unchanged) PLUS the v2-only conviction
// fields for any v2-specific UI. Pure + framework-free so it is unit-testable in isolation.
import { PhaseView, Side, type EpochView } from '@/lib/types';

/** RAW on-chain 6-phase Phase enum (IFeeArena.Phase) returned by the v2 arena. */
export enum RawPhase {
  None = 0,
  EntryOpen = 1,
  Running = 2,
  Resolved = 3,
  Swept = 4,
  Settled = 5,
}

/**
 * The RAW EpochV2 tuple as decoded from the v2 arena's currentEpoch()/getEpoch(). Field order + names
 * mirror abis/feeArenaV2.ts EXACTLY (the `EpochV2` struct in src/FeeArenaV2.sol). viem decodes a named
 * tuple to an object; numerics are bigint (small int32/uint32 may surface as number - both handled).
 * NOTE: there is NO epochId field here (injected by the adapter).
 */
export interface RawEpochV2 {
  phase: RawPhase | number | bigint;
  entryOpenTime: bigint;
  entryCloseTime: bigint;
  startTime: bigint;
  endTime: bigint;
  startTimeActual: bigint;
  settleTimeActual: bigint;
  winningSide: Side | number | bigint;
  rolledOver: boolean;
  rolloverConsumed: boolean;
  sweepCursor: number | bigint;
  stakedCount: number | bigint;
  bandBps: number | bigint;
  startPrice18: bigint;
  settlePrice18: bigint;
  deltaBps: bigint;
  potWETH: bigint;
  potUSDC: bigint;
  sideContribution6: readonly [bigint, bigint, bigint, bigint];
  winnerDenominator: bigint;
  claimedWETH: bigint;
  claimedUSDC: bigint;
  claimedCount: number | bigint;
  subsidyUSDC: bigint;
  sideConviction: readonly [bigint, bigint, bigint, bigint];
  winnerSqrtConvSum: bigint;
  winningConvictionSum: bigint;
  refundedConviction: bigint;
  convRefundedCount: number | bigint;
  burnedConviction: bigint;
}

/**
 * The adapted v2 epoch projection: a structural superset of EpochView (every EpochView field, so all
 * existing consumers work unchanged) PLUS the v2-only conviction-parimutuel fields. The rollover-IN
 * fields (rolloverPendingIn/In*) are always defaulted (the raw struct has no such fields in v2).
 */
export interface EpochV2View extends EpochView {
  /** Bounded USDC subsidy committed to this epoch's pot (v2). */
  subsidyUSDC: bigint;
  /** Per-side staked conviction totals (USDC 6dp), indexed by Side (v2). */
  sideConviction: readonly [bigint, bigint, bigint, bigint];
  /** Σ√conviction over the winning side - the parimutuel payout denominator base (v2). */
  winnerSqrtConvSum: bigint;
  /** Σ conviction over the winning side (v2). */
  winningConvictionSum: bigint;
  /** Losing-side conviction burned to the treasury this epoch (v2). */
  burnedConviction: bigint;
}

/** The exact field order of the RawEpochV2 tuple - used to read a positionally-decoded (array) struct. */
const RAW_FIELD_ORDER: readonly (keyof RawEpochV2)[] = [
  'phase', 'entryOpenTime', 'entryCloseTime', 'startTime', 'endTime', 'startTimeActual',
  'settleTimeActual', 'winningSide', 'rolledOver', 'rolloverConsumed', 'sweepCursor', 'stakedCount',
  'bandBps', 'startPrice18', 'settlePrice18', 'deltaBps', 'potWETH', 'potUSDC', 'sideContribution6',
  'winnerDenominator', 'claimedWETH', 'claimedUSDC', 'claimedCount', 'subsidyUSDC', 'sideConviction',
  'winnerSqrtConvSum', 'winningConvictionSum', 'refundedConviction', 'convRefundedCount',
  'burnedConviction',
];

/** Collapse the RAW 6-phase Phase to the external 4-phase PhaseView (None->Idle, R/R/S->Running). */
export function collapsePhase(raw: RawPhase | number | bigint): PhaseView {
  switch (Number(raw)) {
    case RawPhase.None:
      return PhaseView.Idle;
    case RawPhase.EntryOpen:
      return PhaseView.EntryOpen;
    case RawPhase.Running:
    case RawPhase.Resolved:
    case RawPhase.Swept:
      return PhaseView.Running;
    case RawPhase.Settled:
      return PhaseView.Settled;
    default:
      return PhaseView.Idle;
  }
}

/** Normalize a viem-decoded tuple (object OR positional array) to the keyed RawEpochV2 shape. */
function asKeyed(raw: RawEpochV2 | readonly unknown[]): RawEpochV2 {
  if (Array.isArray(raw)) {
    const out = {} as Record<keyof RawEpochV2, unknown>;
    RAW_FIELD_ORDER.forEach((k, i) => {
      out[k] = (raw as readonly unknown[])[i];
    });
    return out as unknown as RawEpochV2;
  }
  return raw as RawEpochV2;
}

/**
 * Adapt a RAW EpochV2 tuple (from the v2 arena) into an EpochV2View (an EpochView superset).
 * `epochId` is injected (the raw struct has no epochId): pass currentEpochId() for currentEpoch(), or
 * the queried id for getEpoch(id). Pure; tolerant of both object- and array-decoded tuples + bigint
 * numerics for the small int32/uint32 fields.
 */
export function adaptEpochV2(raw: RawEpochV2 | readonly unknown[], epochId: bigint): EpochV2View {
  const r = asKeyed(raw);
  return {
    epochId,
    phase: collapsePhase(r.phase),
    entryOpenTime: r.entryOpenTime,
    entryCloseTime: r.entryCloseTime,
    startTime: r.startTime,
    endTime: r.endTime,
    startTimeActual: r.startTimeActual,
    settleTimeActual: r.settleTimeActual,
    bandBps: Number(r.bandBps),
    startPrice18: r.startPrice18,
    settlePrice18: r.settlePrice18,
    deltaBps: r.deltaBps,
    winningSide: Number(r.winningSide) as Side,
    rolledOver: r.rolledOver,
    stakedCount: Number(r.stakedCount),
    sweepCursor: Number(r.sweepCursor),
    potWETH: r.potWETH,
    potUSDC: r.potUSDC,
    sideContribution6: r.sideContribution6,
    winnerDenominator: r.winnerDenominator,
    // v2 has no rollover-IN payload; these EpochView fields default off so the v1 UI banner stays hidden.
    rolloverPendingIn: false,
    rolloverInWETH: 0n,
    rolloverInUSDC: 0n,
    // v2-only conviction-parimutuel fields.
    subsidyUSDC: r.subsidyUSDC,
    sideConviction: r.sideConviction,
    winnerSqrtConvSum: r.winnerSqrtConvSum,
    winningConvictionSum: r.winningConvictionSum,
    burnedConviction: r.burnedConviction,
  };
}
