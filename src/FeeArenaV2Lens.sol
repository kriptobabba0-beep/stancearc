// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {EpochV2, Position} from "src/FeeArenaV2Types.sol";

/// @title FeeArenaV2Lens - stateless read/preview companion for {FeeArenaV2}.
/// @notice EIP-170 extraction: the heavy read projections (getStake / getStakesByEpoch /
///         previewClaim / previewRefund and their StakeView/ClaimPreview builders) were moved
///         OUT of {FeeArenaV2} into this separate, stateless view contract so the arena's runtime
///         bytecode fits the 24,576-byte limit. The Lens holds NO state of its own beyond the
///         immutable arena address; it reads the arena's PUBLIC surface - the auto-generated
///         `positions` getter, `getEpoch`, and `epochStakeCount`/`epochTokenIdsAt` - and reproduces
///         the EXACT projection math the arena's `claim()` / `refundConviction()` use (sqrt-weighted
///         floor mulDiv; 1:1 conviction refund). The frontend points all previews/listings here.
///
///         Construction: `new FeeArenaV2Lens(address arena)`. One arena per Lens; the binding is
///         immutable. Behavior-identical to the pre-extraction in-contract views (same assertions).
contract FeeArenaV2Lens {
    /// @notice The arena this Lens projects. Set once at construction.
    FeeArenaV2 public immutable arena;

    error ZeroAddress();

    constructor(address arena_) {
        if (arena_ == address(0)) revert ZeroAddress();
        arena = FeeArenaV2(payable(arena_));
    }

    // =====================================================================
    // STAKE PROJECTIONS
    // =====================================================================

    /// @notice Read-optimized projection of a single staked position (was FeeArenaV2.getStake).
    function getStake(uint256 tokenId) external view returns (IFeeArena.StakeView memory s) {
        return _stakeView(tokenId);
    }

    /// @notice All staked-position projections for an epoch (was FeeArenaV2.getStakesByEpoch).
    ///         Paginates the arena's internal token-id list via epochStakeCount/epochTokenIdsAt.
    function getStakesByEpoch(uint64 epochId) external view returns (IFeeArena.StakeView[] memory out) {
        uint256 n = arena.epochStakeCount(epochId);
        out = new IFeeArena.StakeView[](n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = _stakeView(arena.epochTokenIdsAt(epochId, i));
        }
    }

    // =====================================================================
    // CLAIM / REFUND PREVIEWS - mirror the arena's settle math EXACTLY.
    // =====================================================================

    /// @notice Floor projection of a winner's sqrt-weighted pot claim - mirrors arena.claim()
    ///         exactly (weight = sqrt(conviction); payX = floor(potX * weight / winnerDenominator)).
    function previewClaim(uint64 epochId, uint256 tokenId) external view returns (IFeeArena.ClaimPreview memory pv) {
        EpochV2 memory e = arena.getEpoch(epochId);
        Position memory p = arena.getPosition(tokenId);

        pv.contribution6 = p.contribution6;
        pv.winnerDenominator = e.winnerDenominator;
        pv.isWinner = (uint8(e.phase) >= uint8(IFeeArena.Phase.Resolved)) && (p.side == e.winningSide)
            && (p.epochId == epochId) && (p.side != IFeeArena.Side.NONE);
        pv.alreadyClaimed = p.claimed;
        bool settledDone = (e.phase == IFeeArena.Phase.Settled) && !e.rolledOver && (e.sweepCursor == e.stakedCount);
        pv.claimable = settledDone && pv.isWinner && !p.claimed && p.contribution6 > 0;
        if (pv.isWinner && e.winnerDenominator != 0 && p.contribution6 > 0) {
            uint256 weight = Math.sqrt(p.conviction);
            pv.payWETH = Math.mulDiv(e.potWETH, weight, e.winnerDenominator);
            pv.payUSDC = Math.mulDiv(e.potUSDC, weight, e.winnerDenominator);
        }
    }

    /// @notice Preview a position's conviction refund: the EXACT stored `conviction` when it is on
    ///         the winning side, the epoch is Settled, and it has not yet been refunded.
    function previewRefund(uint64 epochId, uint256 tokenId) external view returns (bool refundable, uint256 amount) {
        EpochV2 memory e = arena.getEpoch(epochId);
        Position memory p = arena.getPosition(tokenId);
        refundable = (e.phase == IFeeArena.Phase.Settled) && (p.epochId == epochId) && (p.side == e.winningSide)
            && !p.convictionRefunded;
        amount = refundable ? p.conviction : 0;
    }

    // =====================================================================
    // INTERNAL - build StakeView from the arena's single-struct getPosition copy.
    // =====================================================================

    function _stakeView(uint256 tokenId) internal view returns (IFeeArena.StakeView memory s) {
        Position memory p = arena.getPosition(tokenId);
        s = IFeeArena.StakeView({
            tokenId: tokenId,
            owner: p.owner,
            epochId: p.epochId,
            side: p.side,
            swept: p.swept,
            claimed: p.claimed,
            unstaked: p.unstaked,
            feeWETH: p.feeWETH,
            feeUSDC: p.feeUSDC,
            contribution6: p.contribution6
        });
    }
}
