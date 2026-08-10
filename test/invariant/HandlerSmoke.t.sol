// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {FeeArenaHandler} from "test/invariant/handlers/FeeArenaHandler.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @notice Deterministic coverage proof for the invariant handler: drive the actions by hand to
///         show every property-relevant state is reachable (so the fuzzed invariants are NOT
///         trivially true). Proves: normal-winner claim, empty-winner rollover, foldDust,
///         unstake, AND a >=3-epoch sequential chain incl. empty->empty->normal.
contract HandlerSmokeTest is FeeArenaTestBase {
    FeeArenaHandler internal handler;

    function setUp() public override {
        _deployArenaSystem();
        handler = new FeeArenaHandler(
            arena, oracle, npm, address(weth), address(usdc), address(pool), FEE_TIER, MIN_LIQUIDITY, owner
        );
        vm.prank(owner);
        arena.transferOwnership(address(handler));
        oracle.transferOwnership(address(handler));
    }

    /// Epoch 1 self-advances to DOWN (id % 3 == 1). Stake DOWN with fees -> winner -> claim pays.
    function test_Smoke_NormalWinnerClaimAndFold() public {
        handler.actStakeAndAdvance(0, 2, 0, 5e18, 3000e6); // side 2 = DOWN
        handler.actSweep(8);
        handler.actFinalize();
        assertGe(handler.ghost_epochsSettled(), 1, "epoch should settle");

        uint256 tokenId = handler.allStakedTokens(0);
        IFeeArena.EpochView memory e = arena.getEpoch(arena.getStake(tokenId).epochId);
        assertEq(uint8(e.winningSide), uint8(IFeeArena.Side.DOWN), "should resolve DOWN");
        assertFalse(e.rolledOver, "normal winner: not rolled");

        handler.actClaim(0);
        assertEq(handler.ghost_successfulClaims(), 1, "claim should pay once");
        assertEq(handler.ghost_payoutCount(tokenId), 1, "single payout flip");

        // dust fold after all winners claimed (single winner -> floor leftover may be 0; the
        // call either folds or reverts NothingToFold — both are valid, no revert escapes).
        handler.actFoldDust(1);

        // unstake the swept, settled position (NFT returns to owner; no double payout)
        handler.actUnstake(0);
        assertEq(handler.ghost_successfulUnstakes(), 1, "unstake should succeed once");
        assertEq(handler.ghost_payoutCount(tokenId), 1, "unstake must not pay again");
    }

    /// Stake UP on epoch 1 (resolves DOWN) -> empty winner -> whole pot rolls forward.
    function test_Smoke_EmptyWinnerRollover() public {
        handler.actStakeAndAdvance(0, 1, 0, 4e18, 1000e6); // side 1 = UP, but ep1 resolves DOWN
        handler.actSweep(8);
        handler.actFinalize();
        assertEq(handler.ghost_emptyWinnerEpochs(), 1, "empty-winner epoch reached");
        assertTrue(arena.getEpoch(1).rolledOver, "pot should roll forward");
        assertGt(arena.rolloverWETH(), 0, "rolloverWETH should be funded");
    }

    /// >=3 sequential epochs incl. empty->empty->normal, exercising rollover injection chains.
    function test_Smoke_ThreeEpochChain_EmptyEmptyNormal() public {
        // Epoch 1 (resolves DOWN): stake UP -> empty winner.
        handler.actStakeAndAdvance(0, 1, 0, 2e18, 500e6);
        handler.actSweep(8);
        handler.actFinalize();
        // Epoch 2 (resolves RANGE, id%3==2): stake UP -> empty winner; injects ep1 rollover.
        handler.actStakeAndAdvance(1, 1, 0, 3e18, 700e6);
        handler.actSweep(8);
        handler.actFinalize();
        // Epoch 3 (resolves UP, id%3==0): stake UP -> normal winner; injects ep1+ep2 rollover.
        handler.actStakeAndAdvance(2, 1, 0, 1e18, 900e6);
        handler.actSweep(8);
        handler.actFinalize();

        assertGe(handler.ghost_epochsSettled(), 3, "three epochs should settle");
        assertGe(handler.ghost_emptyWinnerEpochs(), 2, "first two should be empty winners");
        assertTrue(arena.getEpoch(1).rolledOver, "ep1 rolled");
        assertTrue(arena.getEpoch(2).rolledOver, "ep2 rolled");
        assertFalse(arena.getEpoch(3).rolledOver, "ep3 normal winner");
        assertEq(uint8(arena.getEpoch(3).winningSide), uint8(IFeeArena.Side.UP), "ep3 UP");

        // ep3 pot must include the injected rollover from ep1+ep2 (pot > its own swept fee 1e18).
        assertGt(arena.getEpoch(3).potWETH, 1e18, "ep3 pot should include injected rollover");

        // the ep3 UP winner can claim the whole (injected) pot.
        uint256 tok3 = handler.allStakedTokens(2);
        handler.actClaim(2);
        assertEq(handler.ghost_payoutCount(tok3), 1, "ep3 winner paid once");

        // in-order finalize witness held throughout.
        assertEq(handler.ghost_lastFinalized(), 3, "finalize order witness == 3");
        assertEq(arena.lastSettledEpochId(), 3, "lastSettledEpochId == 3");
    }
}
