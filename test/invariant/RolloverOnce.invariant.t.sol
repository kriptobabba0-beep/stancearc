// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {FeeArenaHandler} from "test/invariant/handlers/FeeArenaHandler.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @notice Rollover-exactly-once: the pending global rollover is injected into a settling epoch
///         EXACTLY once (rolloverConsumed guard), and finalizeSettle consumes epochs strictly
///         in order with no gaps, repeats, or drift.
contract RolloverOnceInvariant is FeeArenaTestBase {
    FeeArenaHandler internal handler;

    function setUp() public override {
        _deployArenaSystem();
        handler = new FeeArenaHandler(
            arena, oracle, npm, address(weth), address(usdc), address(pool), FEE_TIER, MIN_LIQUIDITY, owner
        );
        vm.prank(owner);
        arena.transferOwnership(address(handler));
        oracle.transferOwnership(address(handler));

        bytes4[] memory sel = new bytes4[](8);
        sel[0] = handler.actStakeAndAdvance.selector;
        sel[1] = handler.actSeedFees.selector;
        sel[2] = handler.actEndAndResolve.selector;
        sel[3] = handler.actSweep.selector;
        sel[4] = handler.actFinalize.selector;
        sel[5] = handler.actClaim.selector;
        sel[6] = handler.actFoldDust.selector;
        sel[7] = handler.actUnstake.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// rolloverConsumed exactly-once + strictly in-order finalize => no double-inject / no drift.
    function invariant_RolloverExactlyOnce() public view {
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            // never injected the global rollover into the same epoch more than once.
            assertLe(handler.ghost_injectCount(id), 1, "rollover injected more than once");
            IFeeArena.EpochView memory e = arena.getEpoch(id);
            // every settled epoch ran the inject guard (rolloverConsumed flipped true).
            if (e.phase == IFeeArena.PhaseView.Settled) {
                assertTrue(handler.epochRolloverConsumed(id), "settled epoch did not consume rollover guard");
            } else {
                // un-settled epochs must NOT have consumed the guard yet.
                assertFalse(handler.epochRolloverConsumed(id), "rollover consumed before settle");
            }
        }
        // in-order witnesses: lastSettledEpochId never exceeds currentEpochId and matches the
        // handler's monotonic finalize witness (no gaps, no repeats).
        assertLe(arena.lastSettledEpochId(), last, "lastSettledEpochId > currentEpochId");
        assertEq(arena.lastSettledEpochId(), handler.ghost_lastFinalized(), "finalize order drift");
    }
}
