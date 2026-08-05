// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFeeArena} from "src/interfaces/IFeeArena.sol";

// =====================================================================
// FeeArenaV2 canonical storage rows - declared at FILE LEVEL so BOTH the
// main {FeeArenaV2} contract and the external {FeeArenaV2Settlement} library
// reference the SAME struct types. This lets the arena pass `storage` refs to
// its `epochs`/`positions` mappings into the library's public functions (the
// heavy settle/finalize/sweep/claim/refund/foldDust math is deployed in the
// library for EIP-170). The storage LAYOUT is UNCHANGED from the prior
// in-contract definitions (the same field order, so the vm.store slot helpers
// + the EpochV2 ABI the frontend/tests read are byte-identical).
// =====================================================================

/// @dev v2 per-epoch row. Mirrors IFeeArena.Epoch (so the v1 phase machine / sweep / finalize /
///      view logic ports 1:1) and APPENDS the conviction + subsidy accounting fields
///      (spec §STATECHANGES).
struct EpochV2 {
    // ---- v1 fields (mirror IFeeArena.Epoch) ----
    IFeeArena.Phase phase;
    uint64 entryOpenTime;
    uint64 entryCloseTime;
    uint64 startTime;
    uint64 endTime;
    uint64 startTimeActual;
    uint64 settleTimeActual;
    IFeeArena.Side winningSide;
    bool rolledOver;
    bool rolloverConsumed;
    uint32 sweepCursor;
    uint32 stakedCount;
    int32 bandBps;
    uint256 startPrice18;
    uint256 settlePrice18;
    int256 deltaBps;
    uint256 potWETH; // forfeited fees (both legs) + injected rollover + committed R (USDC leg)
    uint256 potUSDC;
    uint256[4] sideContribution6; // indexed by Side (0=NONE unused)
    uint256 winnerDenominator; // = winnerSqrtConvSum at finalize (sqrt-weighted); 0 => empty-winner
    uint256 claimedWETH;
    uint256 claimedUSDC;
    uint32 claimedCount;
    // ---- v2 additions (spec §STATECHANGES) ----
    uint256 subsidyUSDC; // committed R for this epoch (in potUSDC at finalize)
    uint256[4] sideConviction; // conviction sum by Side (mirrors sideContribution6)
    uint256 winnerSqrtConvSum; // frozen Sum(sqrt(c_j)) over winners with contribution6>0
    uint256 winningConvictionSum; // frozen Sum(c_i) over ALL winning-side stakers
    uint256 refundedConviction; // running sum of refunded c_i (exact; solvency + invariant)
    uint32 convRefundedCount; // winners who reclaimed principal
    uint256 burnedConviction; // losing-side conviction swept to TREASURY at finalize
}

/// @dev v2 Position row. Appends `conviction` + `convictionRefunded` to v1's fields WITHOUT
///      disturbing the slot-0 packing the vm.store test helpers rely on (owner..unstaked in slot 0;
///      the uint128 liquidity + uint32 tickSpan pair stays in its own slot). `conviction`/
///      `convictionRefunded` are appended at the END.
struct Position {
    address owner;
    uint64 epochId;
    IFeeArena.Side side;
    bool swept;
    bool claimed;
    bool unstaked;
    uint128 feeWETH;
    uint128 feeUSDC;
    uint256 contribution6;
    // v1 winner-split metric inputs (preserved): liquidity*tickSpan == capital proxy.
    uint128 liquidity;
    uint32 tickSpan;
    // ---- v2 additions (appended; do not reorder the above) ----
    uint256 conviction; // c_i custodied at stake
    bool convictionRefunded; // independent of `claimed` (decouples principal from pot)
}

/// @dev The O(1) GLOBAL aggregate solvency counters (spec §HARDENING C2). Bundled into ONE struct
///      (held in a single arena storage var) so the settlement/staking libraries can take a
///      `Globals storage` ref and update them DIRECTLY - eliminating the large delta-return structs
///      (and their ABI-decode glue) that would otherwise bloat the arena's bytecode. The arena
///      re-exposes each field via a same-named public getter so the external/test surface
///      (`arena.totalOwedWETH()`, etc.) is unchanged.
struct Globals {
    uint256 rolloverWETH;
    uint256 rolloverUSDC;
    uint256 totalOwedWETH;
    uint256 totalOwedUSDC;
    uint256 totalCustodiedConviction;
    uint256 totalCommittedSubsidy;
    uint256 totalLedgerUSDC;
    uint256 totalLedgerWETH;
}

/// @dev Conviction-stake staging keyed by tokenId. `stakeWithConviction` pulls the USDC conviction
///      and stages (staker, side, conviction) BEFORE pushing the NFT; `onERC721Received` reads +
///      clears it. A direct NFT transfer with no staged entry reverts MissingConviction - v2
///      requires conviction on every stake.
struct StakeStaging {
    address staker;
    IFeeArena.Side side;
    uint256 conviction;
    bool pending;
}
