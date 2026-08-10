// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {FeeArenaHandler} from "test/invariant/handlers/FeeArenaHandler.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @notice Single-payout: across claim() and unstake() in ANY order (and any number of repeat
///         calls), a position's reward is realized AT MOST once. `Position.claimed` is the single
///         source of truth — it flips 0->1 at most once, and the owner is paid at most once.
contract SinglePayoutInvariant is FeeArenaTestBase {
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

    /// claim()->unstake(), unstake()->claim(), and repeated calls each realize a payout AT MOST
    /// once, tracked against Position.claimed (the single source of truth).
    function invariant_SinglePayout() public view {
        uint256 n = handler.allStakedTokensLength();
        for (uint256 i = 0; i < n; ++i) {
            uint256 tokenId = handler.allStakedTokens(i);
            // never realized more than one payout flip across claim/unstake orderings.
            assertLe(handler.ghost_payoutCount(tokenId), 1, "paid more than once");
            IFeeArena.StakeView memory s = arena.getStake(tokenId);
            if (!s.claimed) {
                // claimed never flipped => ghost must be 0 (no phantom payout).
                assertEq(handler.ghost_payoutCount(tokenId), 0, "ghost flipped without claimed");
            } else {
                // claimed flipped exactly once => ghost recorded exactly one realized payout.
                assertEq(handler.ghost_payoutCount(tokenId), 1, "claimed but ghost not exactly one");
            }
        }
    }
}
