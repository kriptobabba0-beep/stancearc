// lib/types.ts — TS mirrors of the canonical contract surface. ALL on-chain numerics are bigint;
// format only at render. Struct shapes below mirror src/interfaces/IFeeArena.sol (EpochView /
// StakeView / ClaimPreview) EXACTLY — field order/types verified against the compiled artifact.

/** External 4-phase view (contract collapses internal 6-phase). Built by EpochViewLib. */
export enum PhaseView { Idle = 0, EntryOpen = 1, Running = 2, Settled = 3 }

/** Side: NONE=0 sentinel (never a valid stake/outcome). Staked side must be UP/DOWN/RANGE. */
export enum Side { NONE = 0, UP = 1, DOWN = 2, RANGE = 3 }

/**
 * Cached boot decimals (read once). Hard-fails ONLY on usdc!==6 (mirrors the FeeArena BadDecimals
 * assert, which constrains only the USDC leg). `weth: 18` is a vestigial type-stability constant for
 * the (unused) wethNotionalDiv — it does NOT reflect the base token's real decimals (cirBTC is 8dp)
 * and is never gated. See lib/decimals.ts assertBootDecimals for the matching doc.
 */
export interface BootDecimals { usdc: 6; weth: 18; price: 18; }

/**
 * Read-optimized epoch projection — mirrors IFeeArena.EpochView 1:1 (decoded tuple from
 * currentEpoch()/getEpoch()). NOTE: includes startTimeActual/settleTimeActual and the field
 * is `sweepCursor` (not `sweepCursorDone`) — matches the artifact exactly.
 */
export interface EpochView {
  epochId: bigint;
  phase: PhaseView;
  entryOpenTime: bigint;
  entryCloseTime: bigint;
  startTime: bigint;
  endTime: bigint;
  startTimeActual: bigint;
  settleTimeActual: bigint;
  bandBps: number; // int32 -> number (viem decodes small signed ints to number)
  startPrice18: bigint;
  settlePrice18: bigint;
  deltaBps: bigint; // int256
  winningSide: Side;
  rolledOver: boolean;
  stakedCount: number; // uint32
  sweepCursor: number; // uint32 — staked index swept so far
  potWETH: bigint;
  potUSDC: bigint;
  sideContribution6: readonly [bigint, bigint, bigint, bigint]; // uint256[4], indexed by Side
  winnerDenominator: bigint;
  rolloverPendingIn: boolean;
  rolloverInWETH: bigint;
  rolloverInUSDC: bigint;
}

/** Read-optimized staked-position projection — mirrors IFeeArena.StakeView 1:1. */
export interface StakeView {
  tokenId: bigint;
  owner: `0x${string}`;
  epochId: bigint;
  side: Side;
  swept: boolean;
  claimed: boolean;
  unstaked: boolean;
  feeWETH: bigint; // uint128
  feeUSDC: bigint; // uint128
  contribution6: bigint;
}

/**
 * Read-only floor projection of a winner's claim — mirrors IFeeArena.ClaimPreview 1:1.
 * Field order: isWinner, alreadyClaimed, claimable, contribution6, winnerDenominator, payWETH, payUSDC.
 */
export interface ClaimPreview {
  isWinner: boolean;
  alreadyClaimed: boolean;
  claimable: boolean;
  contribution6: bigint;
  winnerDenominator: bigint;
  payWETH: bigint;
  payUSDC: bigint;
}

/** IPriceOracle.getPrice() -> (price18, updatedAt). 18dp quote (1e18 == $1). */
export interface OraclePrice {
  price18: bigint;
  updatedAt: bigint;
}

/** FeeArena.sweepProgress(id) -> (done, total). Claim gates on done === total. */
export interface SweepProgress {
  done: number;
  total: number;
}

/** A Uniswap V3 position NFT owned by the connected account that is eligible to stake. */
export interface OwnedPosition {
  tokenId: bigint;
  liquidity: bigint;
  /** The position's price band as raw ticks (positions()[5]/[6], int24 -> number). tickLower < tickUpper. */
  tickLower: number;
  tickUpper: number;
}

/** Per-phase capability gate derived from EpochView (+ optional StakeView). */
export interface PhaseGate {
  canStake: boolean;
  canClaim: boolean;
  canUnstake: boolean;
  showProjection: boolean;
  sweepDone: boolean;
}
