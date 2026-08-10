import { EpochView, StakeView, ClaimPreview, PhaseView, Side } from '@/lib/types';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;

/** Base EpochView; override `phase` and any numerics per test. */
export function makeEpochView(overrides: Partial<EpochView> = {}): EpochView {
  return {
    epochId: 1n,
    phase: PhaseView.EntryOpen,
    entryOpenTime: 1000n,
    entryCloseTime: 2000n,
    startTime: 2100n,
    endTime: 2400n,
    startTimeActual: 0n,
    settleTimeActual: 0n,
    bandBps: 150,
    startPrice18: 0n,
    settlePrice18: 0n,
    deltaBps: 0n,
    winningSide: Side.NONE,
    rolledOver: false,
    stakedCount: 3,
    sweepCursor: 0,
    potWETH: 0n,
    potUSDC: 0n,
    sideContribution6: [0n, 8_000_000_000n, 6_000_000_000n, 4_000_000_000n] as const,
    winnerDenominator: 0n,
    rolloverPendingIn: false,
    rolloverInWETH: 0n,
    rolloverInUSDC: 0n,
    ...overrides,
  };
}

/** A settled epoch where UP won (mirrors spec §4.5 worked example). */
export function makeSettledEpochView(overrides: Partial<EpochView> = {}): EpochView {
  return makeEpochView({
    phase: PhaseView.Settled,
    startPrice18: 2955_000000000000000000n, // $2955
    settlePrice18: 3000_000000000000000000n, // $3000
    deltaBps: 152n,
    winningSide: Side.UP,
    stakedCount: 4,
    sweepCursor: 4,
    potWETH: 4_000000000000000000n,
    potUSDC: 6_000_000_000n,
    winnerDenominator: 8_000_000_000n,
    ...overrides,
  });
}

export function makeStakeView(overrides: Partial<StakeView> = {}): StakeView {
  return {
    tokenId: 101n,
    owner: USER,
    epochId: 1n,
    side: Side.UP,
    swept: false,
    claimed: false,
    unstaked: false,
    feeWETH: 0n,
    feeUSDC: 0n,
    contribution6: 0n,
    ...overrides,
  };
}

export function makeClaimPreview(overrides: Partial<ClaimPreview> = {}): ClaimPreview {
  return {
    claimable: false,
    isWinner: false,
    alreadyClaimed: false,
    payWETH: 0n,
    payUSDC: 0n,
    contribution6: 0n,
    winnerDenominator: 0n,
    ...overrides,
  };
}

export const TEST_USER = USER;
export const TEST_ZERO = ZERO_ADDR;
