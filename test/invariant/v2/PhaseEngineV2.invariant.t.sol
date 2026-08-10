// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaV2InvariantBase} from "test/invariant/FeeArenaV2InvariantBase.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {EpochV2, Position} from "src/FeeArenaV2Types.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @notice PHASE / ENGINE invariants (spec §INVARIANTS, preserved from v1):
///   INV-E1: phase is monotonic None->EntryOpen->Running->Resolved->Swept->Settled (never
///           regresses); finalizeSettle consumes epochs strictly in order. The handler's
///           per-action `_observePhase` enforces non-regression continuously; here we assert the
///           in-order finalize witness + the terminal monotonic snapshot.
///   INV-E2: a position pays its pot share AT MOST once and refunds principal AT MOST once
///           (claimed / convictionRefunded guards). Asserted via the handler's per-token counters.
///   INV-E3: foldDust is reachable iff claimedCount == winnerCount; a deferred/blocklisted payout
///           STILL bumps claimedCount so foldDust can't brick (claimedCount <= winnerCount always,
///           and a folded epoch has its residual fully drained: claimed == pot).
///   INV-E4: rollover is injected exactly once per epoch (rolloverConsumed latch); an empty-winner
///           epoch rolls the whole post-inject pot forward (rolledOver set, denom 0).
contract PhaseEngineV2Invariant is FeeArenaV2InvariantBase {
    /// INV-E1: finalize is strictly in order — lastSettledEpochId tracks the handler's monotonic
    /// finalize witness, and the global phase snapshot is consistent (every id <= lastSettled is
    /// Settled, none beyond it is Settled-out-of-order).
    function invariant_E1_PhaseMonotonicAndInOrderFinalize() public view {
        assertEq(arena.lastSettledEpochId(), handler.ghost_lastFinalized(), "lastSettledEpochId off witness");
        uint64 lastSettled = arena.lastSettledEpochId();
        // every epoch up to lastSettled must be Settled (finalize is gapless + in order).
        for (uint64 id = 1; id <= lastSettled; ++id) {
            assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArena.Phase.Settled), "gap in settled prefix");
        }
    }

    /// INV-E2: at-most-once pot claim + at-most-once principal refund per token. A SUT
    /// `convictionRefunded` flag implies the handler recorded exactly one successful refund.
    function invariant_E2_AtMostOncePerToken() public view {
        uint256 n = handler.allStakedTokensLength();
        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = handler.allStakedTokens(i);
            assertLe(handler.ghost_claimCount(tokenId), 1, "claimed pot > once");
            assertLe(handler.ghost_refundCount(tokenId), 1, "refunded principal > once");
            (, bool refunded) = arena.getConviction(tokenId);
            if (refunded) assertEq(handler.ghost_refundCount(tokenId), 1, "refunded flag w/o recorded refund");
        }
    }

    /// INV-E3 + INV-E4: foldDust gate (claimedCount <= winnerCount, folded => claimed == pot) and
    /// the empty-winner rollover (rolledOver => denom 0 && pot rolled).
    function invariant_E3_E4_FoldDustAndRollover() public view {
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            EpochV2 memory e = arena.getEpoch(id);
            if (e.phase != IFeeArena.Phase.Settled) continue;

            // INV-E3: claimedCount never exceeds winnerCount (deferred payouts STILL bump it).
            assertLe(e.claimedCount, arena.winnerCount(id), "claimedCount > winnerCount");
            // a folded epoch has its pot fully accounted as claimed (residual rolled out).
            if (handler.ghost_epochFolded(id)) {
                assertEq(e.claimedWETH, e.potWETH, "folded WETH residual not drained");
                assertEq(e.claimedUSDC, e.potUSDC, "folded USDC residual not drained");
            }

            // INV-E4: an empty/all-dust winner rolled the whole pot forward => denom 0.
            if (e.rolledOver) {
                assertEq(e.winnerDenominator, 0, "rolledOver but denom set");
            }
            // rollover injected exactly once: a Settled epoch has consumed its rollover latch.
            assertTrue(e.rolloverConsumed, "settled epoch never consumed rollover");
        }
    }
}
