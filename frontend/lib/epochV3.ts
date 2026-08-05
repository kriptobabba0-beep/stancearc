// lib/epochV3.ts - adapters that normalize the FeeArenaV3 (ENTRY-ANCHORED) read shapes onto the
// app-wide EpochView / StakeView / ClaimPreview types, plus the v3 extras the new UI surfaces
// need (entry anchors, per-position outcomes, settlement price).
//
// Mapping philosophy (mirrors lib/epochV2.ts): every EXISTING component keeps working off the
// normalized fields -
//   - the countdown chain: v3 has no start/end pair; the lock period runs entryClose ->
//     settlementTime, so startTime := entryCloseTime and endTime := settlementTime (the
//     Running-phase countdown then targets settlement, which is exactly what v3 users watch);
//   - phase: Idle->Idle, EntryOpen->EntryOpen, Locked/Settling->Running, Settled->Settled
//     (the app's 4-phase PhaseView). The RAW 5-phase view is preserved in `v3.phaseV3`;
//   - pots: potWETH := potBase (the app's "WETH" leg IS the base/cirBTC leg everywhere);
//   - winningSide := NONE always - v3 HAS no global winner; per-position results live on
//     the stake views (won/entryPrice18) and the UI must use per-position language.
import { PhaseView, Side, type EpochView, type StakeView, type ClaimPreview } from '@/lib/types';

/** Raw 5-phase PhaseView returned by FeeArenaV3's epoch views (mirrors IFeeArenaV3.PhaseView). */
export enum PhaseViewV3 {
  Idle = 0,
  EntryOpen = 1,
  Locked = 2,
  Settling = 3,
  Settled = 4,
}

/** Decoded tuple of FeeArenaV3.currentEpoch()/getEpoch() (named decode via the const ABI). */
export interface RawEpochV3 {
  epochId: bigint;
  phase: number;
  entryOpenTime: bigint;
  entryCloseTime: bigint;
  settlementTime: bigint;
  settleTimeActual: bigint;
  bandBps: number;
  rolledOver: boolean;
  stakedCount: number;
  processedCursor: number;
  winnerCount: number;
  claimedCount: number;
  finalPrice18: bigint;
  potBase: bigint;
  potUSDC: bigint;
  totalWinnerContribution: bigint;
  rolloverPendingIn: boolean;
  rolloverInBase: bigint;
  rolloverInUSDC: bigint;
}

/** v3 extras carried alongside the normalized EpochView. */
export interface EpochV3Extras {
  phaseV3: PhaseViewV3;
  settlementTime: bigint;
  finalPrice18: bigint;
  processedCursor: number;
  winnerCount: number;
  totalWinnerContribution: bigint;
}

export type EpochV3View = EpochView & { v3: EpochV3Extras };

/** Collapse the raw 5-phase v3 view onto the app's 4-phase PhaseView. */
export function collapsePhaseV3(raw: number): PhaseView {
  switch (raw) {
    case PhaseViewV3.Idle:
      return PhaseView.Idle;
    case PhaseViewV3.EntryOpen:
      return PhaseView.EntryOpen;
    case PhaseViewV3.Locked:
    case PhaseViewV3.Settling:
      return PhaseView.Running;
    default:
      return PhaseView.Settled;
  }
}

/** Adapt a raw v3 epoch view onto the app-wide EpochView (+ v3 extras). */
export function adaptEpochV3(raw: RawEpochV3): EpochV3View {
  return {
    epochId: raw.epochId,
    phase: collapsePhaseV3(Number(raw.phase)),
    entryOpenTime: raw.entryOpenTime,
    entryCloseTime: raw.entryCloseTime,
    // v3's watch period runs entryClose -> settlementTime; map it onto the start/end pair the
    // countdown chain consumes (Running counts down to endTime == the settlement moment).
    startTime: raw.entryCloseTime,
    endTime: raw.settlementTime,
    startTimeActual: 0n,
    settleTimeActual: raw.settleTimeActual,
    bandBps: Number(raw.bandBps),
    // No global start price exists; the settlement price doubles as settlePrice18 for the
    // post-settlement displays (receipts, history rows).
    startPrice18: 0n,
    settlePrice18: raw.finalPrice18,
    deltaBps: 0n,
    winningSide: Side.NONE, // v3 has NO global winner - use per-position results
    rolledOver: raw.rolledOver,
    stakedCount: Number(raw.stakedCount),
    sweepCursor: Number(raw.processedCursor),
    potWETH: raw.potBase,
    potUSDC: raw.potUSDC,
    sideContribution6: [0n, 0n, 0n, 0n],
    winnerDenominator: raw.totalWinnerContribution,
    rolloverPendingIn: raw.rolloverPendingIn,
    rolloverInWETH: raw.rolloverInBase,
    rolloverInUSDC: raw.rolloverInUSDC,
    v3: {
      phaseV3: Number(raw.phase) as PhaseViewV3,
      settlementTime: raw.settlementTime,
      finalPrice18: raw.finalPrice18,
      processedCursor: Number(raw.processedCursor),
      winnerCount: Number(raw.winnerCount),
      totalWinnerContribution: raw.totalWinnerContribution,
    },
  };
}

/** Decoded tuple of FeeArenaV3.getStake()/getUserStakes()/getStakesByEpoch() entries. */
export interface RawStakeV3 {
  tokenId: bigint;
  owner: `0x${string}`;
  epochId: bigint;
  side: number;
  entryTime: bigint;
  entryPrice18: bigint;
  processed: boolean;
  won: boolean;
  claimed: boolean;
  unstaked: boolean;
  feeBase: bigint;
  feeUSDC: bigint;
  contributionUsd6: bigint;
}

/** v3 extras carried alongside the normalized StakeView. */
export interface StakeV3Extras {
  entryPrice18: bigint;
  entryTime: bigint;
  processed: boolean;
  won: boolean;
}

export type StakeV3View = StakeView & { v3: StakeV3Extras };

/** Adapt a raw v3 stake onto the app-wide StakeView (+ entry-anchor extras). */
export function adaptStakeV3(raw: RawStakeV3): StakeV3View {
  return {
    tokenId: raw.tokenId,
    owner: raw.owner,
    epochId: raw.epochId,
    side: Number(raw.side) as Side,
    // `swept` gates the manual-unstake affordance app-wide; v3's equivalent is `processed`.
    swept: raw.processed,
    claimed: raw.claimed,
    unstaked: raw.unstaked,
    feeWETH: raw.feeBase,
    feeUSDC: raw.feeUSDC,
    contribution6: raw.contributionUsd6,
    v3: {
      entryPrice18: raw.entryPrice18,
      entryTime: raw.entryTime,
      processed: raw.processed,
      won: raw.won,
    },
  };
}

/**
 * Collapse `getUserStakes` rows to one per tokenId, keeping the first occurrence.
 *
 * WHY: FeeArenaV3.getUserStakes() walks `userEpochTokenIds[user][ep]` across EVERY epoch
 * 1..current. That mapping is append-only - a tokenId is pushed on each stake and never
 * removed - while `positions` is keyed by tokenId alone. So an LP NFT re-staked across K
 * epochs (e.g. #26 in epoch 126 AND epoch 219, after auto-return + re-stake) shows up K
 * times, and every copy resolves to the SAME current positions[tokenId] (byte-identical).
 * Without this, "Your positions" rendered the one true position K times. De-duping by
 * tokenId is lossless: the copies are identical, so one row faithfully represents the
 * single live position.
 */
export function dedupeStakesByTokenId<T extends StakeView>(stakes: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of stakes) {
    const key = s.tokenId.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Decoded tuple of FeeArenaV3.previewClaim(tokenId). */
export interface RawPreviewV3 {
  claimable: boolean;
  isWinner: boolean;
  alreadyClaimed: boolean;
  changeBps: bigint;
  ownFeeBase: bigint;
  ownFeeUSDC: bigint;
  potShareBase: bigint;
  potShareUSDC: bigint;
}

/** v3 extras carried alongside the normalized ClaimPreview. */
export interface PreviewV3Extras {
  changeBps: bigint;
  ownFeeBase: bigint;
  ownFeeUSDC: bigint;
  potShareBase: bigint;
  potShareUSDC: bigint;
}

export type ClaimPreviewV3 = ClaimPreview & { v3: PreviewV3Extras };

/** Adapt a raw v3 preview onto the app-wide ClaimPreview: pay = own fees + pot share. */
export function adaptPreviewV3(raw: RawPreviewV3): ClaimPreviewV3 {
  return {
    isWinner: raw.isWinner,
    alreadyClaimed: raw.alreadyClaimed,
    claimable: raw.claimable,
    contribution6: 0n,
    winnerDenominator: 0n,
    payWETH: raw.ownFeeBase + raw.potShareBase,
    payUSDC: raw.ownFeeUSDC + raw.potShareUSDC,
    v3: {
      changeBps: raw.changeBps,
      ownFeeBase: raw.ownFeeBase,
      ownFeeUSDC: raw.ownFeeUSDC,
      potShareBase: raw.potShareBase,
      potShareUSDC: raw.potShareUSDC,
    },
  };
}

/**
 * The per-position thresholds an entry anchor implies (UI mirror of FeeArenaV3.outcomeOf):
 * UP wins at/above `upAt`, DOWN at/below `downAt`, RANGE strictly between. Pure bigint math:
 *   upAt   = entry * (10_000 + band) / 10_000   (the +band boundary, inclusive)
 *   downAt = entry * (10_000 - band) / 10_000   (the -band boundary, inclusive)
 */
export function entryThresholds(entryPrice18: bigint, bandBps: number): { upAt: bigint; downAt: bigint } {
  const b = BigInt(bandBps);
  return {
    upAt: (entryPrice18 * (10_000n + b)) / 10_000n,
    downAt: (entryPrice18 * (10_000n - b)) / 10_000n,
  };
}

/** UI mirror of the on-chain outcome rule. Returns the side that WOULD be correct at `price18`. */
export function correctSideAt(entryPrice18: bigint, price18: bigint, bandBps: number): Side {
  if (entryPrice18 === 0n) return Side.NONE;
  const changeBps = ((price18 - entryPrice18) * 10_000n) / entryPrice18;
  const b = BigInt(bandBps);
  if (changeBps >= b) return Side.UP;
  if (changeBps <= -b) return Side.DOWN;
  return Side.RANGE;
}

/** A live "are these positions currently qualifying?" tally (by position count). */
export interface QualificationTally {
  qualifying: number;
  notQualifying: number;
  total: number;
}

/**
 * Count how many positions are currently QUALIFYING in the entry-anchored model. Each position is
 * judged against ITS OWN entry anchor (not a global start price): it qualifies when the side that
 * would be correct at `currentPrice18` equals the side it staked. One NFT = one vote (count, not
 * depth) - because every position has a different reference price, a UP/DOWN/RANGE split would read
 * like misleading global sentiment. Returns a 0/0 split (total preserved) when there is no live
 * price, so the caller can show an "awaiting price" state instead of a misclassified bar.
 */
export function tallyQualifyingV3(
  stakes: readonly StakeV3View[],
  currentPrice18: bigint,
  bandBps: number,
): QualificationTally {
  const total = stakes.length;
  if (currentPrice18 <= 0n) return { qualifying: 0, notQualifying: 0, total };
  let qualifying = 0;
  for (const s of stakes) {
    if (correctSideAt(s.v3.entryPrice18, currentPrice18, bandBps) === s.side) qualifying += 1;
  }
  return { qualifying, notQualifying: total - qualifying, total };
}
