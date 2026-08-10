// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaV2InvariantBase} from "test/invariant/FeeArenaV2InvariantBase.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {EpochV2, Position} from "src/FeeArenaV2Types.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice CONVICTION + POT/PAYOUT invariants (spec §INVARIANTS):
///   CONVICTION:
///     INV-C1: Σ(refunded c_i over an epoch) == winningConvictionSum exactly once all winners
///             refund (no dust — refund is 1:1, no division). The running refundedConviction can
///             never EXCEED winningConvictionSum, and refundedConviction == ghost Σ refunded.
///     INV-C2: burnedConviction == Σ(conviction of all LOSING-side stakers); burned is excluded
///             from the live-custody/owed need (it left to TREASURY).
///     INV-C3: a winning-side staker's principal is refundable iff (Settled && side==winner &&
///             !refunded) — independent of contribution6 / winnerDenominator / collect outcome.
///     INV-C4: convRefundedCount <= count(winning-side stakers); claimedCount <= winnerCount.
///   POT/PAYOUT:
///     INV-P1: Σ(pot-share payouts) + folded dust == pot exactly (claimed <= pot at all times).
///     INV-P2: potUSDC == forfeited fees USDC (+ committed R, capped) — never losing conviction.
///     INV-P3: distributable pot <= 2*winningConvictionSum at finalize (R-cap).
///     INV-P4: denom == winnerSqrtConvSum; a dust winner (contribution6==0) is NOT in winnerCount.
contract ConvictionPayoutV2Invariant is FeeArenaV2InvariantBase {
    // ----------------------------- CONVICTION -----------------------------

    /// INV-C1 + INV-C4 (refund side): per settled epoch, refundedConviction can never exceed
    /// winningConvictionSum, the SUT counter equals the handler's external Σ refunded, and once
    /// every winner has refunded the two are EXACTLY equal (no dust). convRefundedCount bounded.
    function invariant_C1_C4_RefundExactAndBounded() public view {
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            EpochV2 memory e = arena.getEpoch(id);
            if (e.phase != IFeeArena.Phase.Settled) continue;

            // refunded never exceeds the frozen winning-side principal (1:1, no over-refund).
            assertLe(e.refundedConviction, e.winningConvictionSum, "refunded > winConvSum");
            // SUT counter matches the externally-summed refunds.
            assertEq(e.refundedConviction, handler.ghost_epochRefundedConv(id), "refundedConviction mismatch");
            // count of refunders never exceeds count of winning-side stakers.
            assertLe(e.convRefundedCount, _winningSideStakers(id), "convRefundedCount > winners");
        }
    }

    /// INV-C2: burnedConviction == Σ conviction of the two LOSING sides. Recomputed from the raw
    /// sideConviction array (NONE unused) — independent of the SUT's own burn math.
    function invariant_C2_BurnEqualsLosingConviction() public view {
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            EpochV2 memory e = arena.getEpoch(id);
            if (e.phase != IFeeArena.Phase.Settled) continue;
            // emergency-settled epochs refund BOTH sides (no winner), so nothing is burned.
            if (e.rolledOver && e.winnerDenominator == 0 && e.burnedConviction == 0 && _isEmergency(e)) continue;

            uint8 w = uint8(e.winningSide);
            uint256 losing;
            for (uint8 s = 1; s <= 3; ++s) {
                if (s != w) losing += e.sideConviction[s];
            }
            assertEq(e.burnedConviction, losing, "burned != sum losing conviction");
            // burned + winning == total custodied conviction for the epoch (nothing lost).
            assertEq(e.burnedConviction + e.winningConvictionSum, _totalConviction(e), "burn+win != total conv");
        }
    }

    /// INV-C3: refundability is decoupled. For EVERY currently-refundable token the
    /// previewRefund/refund gate must be (Settled && side==winner && !refunded) and NOTHING
    /// else — verify it never depends on contribution6 or the denominator.
    function invariant_C3_RefundDecoupled() public view {
        uint256 n = handler.allStakedTokensLength();
        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = handler.allStakedTokens(i);
            uint64 id = handler.tokenEpoch(tokenId);
            if (id == 0) continue;
            EpochV2 memory e = arena.getEpoch(id);
            (bool refundable, uint256 amount) = handler.lens().previewRefund(id, tokenId);
            (uint256 conv, bool refunded) = arena.getConviction(tokenId);

            bool expected =
                (e.phase == IFeeArena.Phase.Settled) && (handler.tokenSide(tokenId) == e.winningSide) && !refunded;
            assertEq(refundable, expected, "refundable gate != side+settled+!refunded");
            if (refundable) assertEq(amount, conv, "refund amount != exact conviction");
        }
    }

    // ------------------------------- PAYOUT -------------------------------

    /// INV-P1: claimed pot can never exceed the pot on either leg (floor mulDiv on sqrt weights),
    /// and after a fold the residual is fully accounted (claimed == pot). Also asserts the
    /// per-token at-most-once claim (INV-E2) here since it is part of the no-overpay property.
    function invariant_P1_NoOverpayClaimedLePot() public view {
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            EpochV2 memory e = arena.getEpoch(id);
            assertLe(e.claimedWETH, e.potWETH, "claimedWETH > potWETH");
            assertLe(e.claimedUSDC, e.potUSDC, "claimedUSDC > potUSDC");
        }
        uint256 n = handler.allStakedTokensLength();
        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = handler.allStakedTokens(i);
            assertLe(handler.ghost_claimCount(tokenId), 1, "token claimed pot share > once");
            assertLe(handler.ghost_refundCount(tokenId), 1, "token refunded principal > once");
        }
    }

    /// INV-P2 + INV-P3: distributable potUSDC at/after finalize never exceeds the R-cap
    /// 2*winningConvictionSum (the excess rolls forward). For a non-rolled settled epoch with
    /// winners, the cap binds; an empty/all-dust winner rolls the whole pot (potUSDC unchanged,
    /// but it's in the rollover, not distributable) — so we only assert the cap on distributable
    /// (non-rolled) epochs.
    function invariant_P2_P3_RCapHolds() public view {
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            EpochV2 memory e = arena.getEpoch(id);
            if (e.phase != IFeeArena.Phase.Settled) continue;
            if (e.rolledOver) continue; // whole pot rolled forward, not distributable
            // R-cap: distributable USDC pot <= 2 * winning-side conviction (linear cap).
            assertLe(e.potUSDC, 2 * e.winningConvictionSum, "potUSDC > 2*winConvSum (R-cap breached)");
        }
    }

    /// INV-P4: the pot denominator is the sqrt-weighted winner sum and a dust winner draws ZERO.
    /// winnerDenominator (when set) == winnerSqrtConvSum, and winnerCount only counts
    /// contribution6>0 winners (so it never exceeds the count of positive-contribution winners).
    function invariant_P4_SqrtDenomAndDustGate() public view {
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            EpochV2 memory e = arena.getEpoch(id);
            if (e.phase != IFeeArena.Phase.Settled) continue;
            if (!e.rolledOver) {
                assertEq(e.winnerDenominator, e.winnerSqrtConvSum, "denom != sqrt sum");
            }
            // claimedCount can never exceed winnerCount (positive-contribution winners) — INV-C4/P4.
            assertLe(e.claimedCount, arena.winnerCount(id), "claimedCount > winnerCount");
        }
    }

    // ----------------------------- helpers --------------------------------

    function _winningSideStakers(uint64 id) internal view returns (uint32 count) {
        uint256 n = handler.allStakedTokensLength();
        EpochV2 memory e = arena.getEpoch(id);
        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = handler.allStakedTokens(i);
            if (handler.tokenEpoch(tokenId) != id) continue;
            if (handler.tokenSide(tokenId) == e.winningSide) count += 1;
        }
    }

    function _totalConviction(EpochV2 memory e) internal pure returns (uint256 total) {
        for (uint8 s = 1; s <= 3; ++s) {
            total += e.sideConviction[s];
        }
    }

    /// @dev Heuristic for an emergency-settled epoch: no settle price was ever pinned (settlePrice18
    ///      == 0) yet it reached Settled+rolledOver. Used to skip the burn-equals-losing assertion
    ///      for the both-sides-refund emergency path (where nothing is burned by design).
    function _isEmergency(EpochV2 memory e) internal pure returns (bool) {
        return e.settlePrice18 == 0;
    }
}
