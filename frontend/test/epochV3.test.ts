import { describe, it, expect } from 'vitest';
import {
  adaptEpochV3,
  adaptStakeV3,
  dedupeStakesByTokenId,
  adaptPreviewV3,
  collapsePhaseV3,
  entryThresholds,
  correctSideAt,
  tallyQualifyingV3,
  PhaseViewV3,
  type RawEpochV3,
  type RawStakeV3,
  type RawPreviewV3,
} from '@/lib/epochV3';
import { PhaseView, Side } from '@/lib/types';

const rawEpoch = (over: Partial<RawEpochV3> = {}): RawEpochV3 => ({
  epochId: 7n,
  phase: PhaseViewV3.Settled,
  entryOpenTime: 1000n,
  entryCloseTime: 1300n,
  settlementTime: 1900n,
  settleTimeActual: 1905n,
  bandBps: 150,
  rolledOver: false,
  stakedCount: 3,
  processedCursor: 3,
  winnerCount: 1,
  claimedCount: 0,
  finalPrice18: 102_200n * 10n ** 18n,
  potBase: 0n,
  potUSDC: 60_000_000n,
  totalWinnerContribution: 100_000_000n,
  rolloverPendingIn: false,
  rolloverInBase: 0n,
  rolloverInUSDC: 0n,
  ...over,
});

describe('collapsePhaseV3 — 5-phase v3 -> app 4-phase PhaseView', () => {
  it('Idle/EntryOpen pass through; Locked+Settling -> Running; Settled -> Settled', () => {
    expect(collapsePhaseV3(PhaseViewV3.Idle)).toBe(PhaseView.Idle);
    expect(collapsePhaseV3(PhaseViewV3.EntryOpen)).toBe(PhaseView.EntryOpen);
    expect(collapsePhaseV3(PhaseViewV3.Locked)).toBe(PhaseView.Running);
    expect(collapsePhaseV3(PhaseViewV3.Settling)).toBe(PhaseView.Running);
    expect(collapsePhaseV3(PhaseViewV3.Settled)).toBe(PhaseView.Settled);
  });
});

describe('adaptEpochV3 — normalize onto EpochView', () => {
  it('maps the lock window onto the start/end countdown pair + pots onto WETH leg', () => {
    const v = adaptEpochV3(rawEpoch());
    expect(v.epochId).toBe(7n);
    expect(v.phase).toBe(PhaseView.Settled);
    // the countdown chain consumes start/end; v3's watch runs entryClose -> settlement
    expect(v.startTime).toBe(1300n);
    expect(v.endTime).toBe(1900n);
    expect(v.potWETH).toBe(0n); // potBase
    expect(v.potUSDC).toBe(60_000_000n);
    expect(v.settlePrice18).toBe(102_200n * 10n ** 18n); // finalPrice doubles as settlePrice
    expect(v.winnerDenominator).toBe(100_000_000n); // totalWinnerContribution
  });

  it('has NO global winning side (per-position model)', () => {
    expect(adaptEpochV3(rawEpoch()).winningSide).toBe(Side.NONE);
  });

  it('carries the v3 extras (phaseV3 + settlement + winnerCount)', () => {
    const v = adaptEpochV3(rawEpoch({ phase: PhaseViewV3.Settling }));
    expect(v.v3.phaseV3).toBe(PhaseViewV3.Settling);
    expect(v.v3.settlementTime).toBe(1900n);
    expect(v.v3.winnerCount).toBe(1);
    expect(v.phase).toBe(PhaseView.Running); // Settling collapses to Running
  });
});

describe('adaptStakeV3 — normalize onto StakeView', () => {
  const rawStake = (over: Partial<RawStakeV3> = {}): RawStakeV3 => ({
    tokenId: 22n,
    owner: '0xabc0000000000000000000000000000000000001',
    epochId: 7n,
    side: Side.UP,
    entryTime: 1250n,
    entryPrice18: 100_000n * 10n ** 18n,
    processed: true,
    won: true,
    claimed: false,
    unstaked: false,
    feeBase: 0n,
    feeUSDC: 100_000_000n,
    contributionUsd6: 100_000_000n,
    ...over,
  });

  it('maps processed->swept, feeBase->feeWETH, contributionUsd6->contribution6, keeps the anchor on .v3', () => {
    const s = adaptStakeV3(rawStake());
    expect(s.tokenId).toBe(22n);
    expect(s.swept).toBe(true); // processed
    expect(s.feeWETH).toBe(0n); // feeBase
    expect(s.feeUSDC).toBe(100_000_000n);
    expect(s.contribution6).toBe(100_000_000n);
    expect(s.v3.entryPrice18).toBe(100_000n * 10n ** 18n);
    expect(s.v3.won).toBe(true);
    expect(s.v3.processed).toBe(true);
  });
});

describe('dedupeStakesByTokenId — collapse getUserStakes cross-epoch duplicates', () => {
  // FeeArenaV3.getUserStakes() enumerates userEpochTokenIds[user][ep] across EVERY epoch, and
  // that mapping is append-only while `positions` is keyed by tokenId. So an LP NFT re-staked
  // across epochs (e.g. #26 in epoch 126 AND epoch 219) appears once per epoch, every copy
  // resolving to the SAME current positions[tokenId] (identical bytes). The UI showed it twice.
  const rawStake = (over: Partial<RawStakeV3> = {}): RawStakeV3 => ({
    tokenId: 26n,
    owner: '0x7303ec2c1334910b42b716166d40b02d7fe8d0fd',
    epochId: 219n,
    side: Side.RANGE,
    entryTime: 1250n,
    entryPrice18: 63_977n * 10n ** 18n,
    processed: false,
    won: false,
    claimed: false,
    unstaked: false,
    feeBase: 0n,
    feeUSDC: 0n,
    contributionUsd6: 0n,
    ...over,
  });

  it('collapses the same tokenId staked across epochs to a single row', () => {
    // getUserStakes returns #26 twice — both resolve to positions[26] so they are identical.
    const dupes = [adaptStakeV3(rawStake()), adaptStakeV3(rawStake())];
    const out = dedupeStakesByTokenId(dupes);
    expect(out).toHaveLength(1);
    expect(out[0].tokenId).toBe(26n);
  });

  it('keeps distinct tokenIds and preserves first-seen order', () => {
    const a = adaptStakeV3(rawStake({ tokenId: 26n }));
    const b = adaptStakeV3(rawStake({ tokenId: 30n }));
    const c = adaptStakeV3(rawStake({ tokenId: 26n })); // duplicate of a
    const out = dedupeStakesByTokenId([a, b, c]);
    expect(out.map((s) => s.tokenId)).toEqual([26n, 30n]);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeStakesByTokenId([])).toEqual([]);
  });
});

describe('tallyQualifyingV3 — live "qualifying now" by position count', () => {
  const E = (n: number) => BigInt(n) * 10n ** 18n;
  const mk = (side: Side, entry: bigint) =>
    adaptStakeV3({
      tokenId: 1n,
      owner: '0xabc0000000000000000000000000000000000001',
      epochId: 9n,
      side,
      entryTime: 1n,
      entryPrice18: entry,
      processed: false,
      won: false,
      claimed: false,
      unstaked: false,
      feeBase: 0n,
      feeUSDC: 0n,
      contributionUsd6: 0n,
    });

  it('judges each position against its OWN entry vs the current price (band 200bps)', () => {
    const current = E(102000);
    const stakes = [
      mk(Side.UP, E(100000)), // +2.00% -> UP -> matches UP -> qualifying
      mk(Side.RANGE, E(100000)), // +2.00% -> UP -> != RANGE -> not
      mk(Side.UP, E(101000)), // +0.99% -> RANGE -> != UP -> not
      mk(Side.DOWN, E(105000)), // -2.86% -> DOWN -> matches DOWN -> qualifying
    ];
    expect(tallyQualifyingV3(stakes, current, 200)).toEqual({ qualifying: 2, notQualifying: 2, total: 4 });
  });

  it('returns a 0/0 split (total preserved) when there is no live price', () => {
    expect(tallyQualifyingV3([mk(Side.UP, E(100000))], 0n, 200)).toEqual({
      qualifying: 0,
      notQualifying: 0,
      total: 1,
    });
  });

  it('is all-zero for no positions', () => {
    expect(tallyQualifyingV3([], E(100000), 200)).toEqual({ qualifying: 0, notQualifying: 0, total: 0 });
  });
});

describe('adaptPreviewV3 — pay = own fees + pot share', () => {
  const rawPreview = (over: Partial<RawPreviewV3> = {}): RawPreviewV3 => ({
    claimable: true,
    isWinner: true,
    alreadyClaimed: false,
    changeBps: 220n,
    ownFeeBase: 0n,
    ownFeeUSDC: 100_000_000n,
    potShareBase: 0n,
    potShareUSDC: 60_000_000n,
    ...over,
  });

  it('sums own fees + pot share into payWETH/payUSDC', () => {
    const p = adaptPreviewV3(rawPreview());
    expect(p.isWinner).toBe(true);
    expect(p.claimable).toBe(true);
    expect(p.payUSDC).toBe(160_000_000n); // 100 own + 60 pot
    expect(p.payWETH).toBe(0n);
    expect(p.v3.changeBps).toBe(220n);
    expect(p.v3.potShareUSDC).toBe(60_000_000n);
  });

  it('a loser preview is not claimable + zero pay', () => {
    const p = adaptPreviewV3(rawPreview({ claimable: false, isWinner: false, ownFeeUSDC: 0n, potShareUSDC: 0n }));
    expect(p.claimable).toBe(false);
    expect(p.isWinner).toBe(false);
    expect(p.payUSDC).toBe(0n);
  });
});

describe('entryThresholds + correctSideAt — UI mirror of FeeArenaV3.outcomeOf', () => {
  const ENTRY = 100_000n * 10n ** 18n;

  it('±1.5% band thresholds are inclusive boundaries', () => {
    const { upAt, downAt } = entryThresholds(ENTRY, 150);
    expect(upAt).toBe(101_500n * 10n ** 18n);
    expect(downAt).toBe(98_500n * 10n ** 18n);
  });

  it('correctSideAt matches the PDF table (220->UP, 120->RANGE, -200->DOWN)', () => {
    expect(correctSideAt(ENTRY, 102_200n * 10n ** 18n, 150)).toBe(Side.UP);
    expect(correctSideAt(ENTRY, 101_200n * 10n ** 18n, 150)).toBe(Side.RANGE);
    expect(correctSideAt(ENTRY, 98_000n * 10n ** 18n, 150)).toBe(Side.DOWN);
  });

  it('exactly +/-1.5% counts UP/DOWN (inclusive), one bps inside is RANGE', () => {
    expect(correctSideAt(ENTRY, 101_500n * 10n ** 18n, 150)).toBe(Side.UP);
    expect(correctSideAt(ENTRY, 98_500n * 10n ** 18n, 150)).toBe(Side.DOWN);
    expect(correctSideAt(ENTRY, 101_490n * 10n ** 18n, 150)).toBe(Side.RANGE);
  });

  it('a zero entry anchor yields NONE (defensive — never divides by zero)', () => {
    expect(correctSideAt(0n, 102_000n * 10n ** 18n, 150)).toBe(Side.NONE);
  });
});
