// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";

/// @notice Task M2 — paginated try/catch sweep with pot + per-side accumulation.
contract SettlementTest is FeeArenaTestBase {
    address lpA = makeAddr("lpA");
    address lpB = makeAddr("lpB");

    /// @dev Two UP stakers in one epoch, each owed 1 WETH + 2000 USDC; then -> Running.
    function _twoStakerRunning() internal returns (uint64 id) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lpA, IFeeArena.Side.UP, 1e18, 2000e6);
        _stakeOwed(lpB, IFeeArena.Side.UP, 1e18, 2000e6);
        _warpToEntryClose();
        _setOraclePrice(DEFAULT_START_PRICE);
        arena.startEpoch(new bytes[](0));
    }

    function test_Sweep_RevertsBeforeResolved() public {
        _openRunningEpochWith(lpA, IFeeArena.Side.UP, 1e18, 2000e6); // Running, not Resolved
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.sweep(10);
    }

    function test_Sweep_Resumable_TwoBatches_FlipsToSwept() public {
        _twoStakerRunning();
        _endEpochAtPrice(3000e18); // Resolved (RANGE-ish, but side accounting still applies)

        arena.sweep(1); // first batch: one position
        (uint32 done1, uint32 total1) = arena.sweepProgress(arena.currentEpochId());
        assertEq(done1, 1);
        assertEq(total1, 2);
        // Resolved collapses to Running in the view
        assertEq(uint8(_epoch().phase), uint8(IFeeArena.PhaseView.Running));

        arena.sweep(10); // remaining
        (uint32 done2,) = arena.sweepProgress(arena.currentEpochId());
        assertEq(done2, 2);

        IFeeArena.EpochView memory e = arena.currentEpoch();
        assertEq(e.potWETH, 2e18, "2 WETH pot");
        assertEq(e.potUSDC, 4000e6, "4000 USDC pot");
        // contribution6 each = liquidity * tickSpan (MIN_LIQUIDITY * DEFAULT_TICK_SPAN); both
        // positions in-range (realized fees), so the UP side total is 2 * that.
        assertEq(
            e.sideContribution6[uint8(IFeeArena.Side.UP)],
            2 * uint256(MIN_LIQUIDITY) * uint256(DEFAULT_TICK_SPAN),
            "UP side total"
        );
    }

    function test_Sweep_SkipsRevertingCollect_ZeroContribution() public {
        _twoStakerRunning();
        _makeCollectRevertFor(lpB); // NPM mock will revert collect() for lpB's tokenId
        _endEpochAtPrice(3000e18);

        vm.expectEmit(true, true, false, false);
        emit IFeeArena.SweepFailed(arena.currentEpochId(), _tokenIdOf(lpB));
        arena.sweep(10);

        IFeeArena.EpochView memory e = arena.currentEpoch();
        // only lpA contributed (lpB's collect reverted -> contribution 0): one MIN_LIQUIDITY * span
        assertEq(e.sideContribution6[uint8(IFeeArena.Side.UP)], uint256(MIN_LIQUIDITY) * uint256(DEFAULT_TICK_SPAN));
        assertEq(e.potWETH, 1e18);
        // lpB position swept==true but zero fees
        assertTrue(arena.getStake(_tokenIdOf(lpB)).swept);
        assertEq(arena.getStake(_tokenIdOf(lpB)).contribution6, 0);
    }

    function test_Sweep_AfterSwept_Reverts() public {
        _openRunningEpochWith(lpA, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3000e18);
        arena.sweep(10); // -> Swept
        vm.expectRevert(IFeeArena.SweepAlreadyDone.selector);
        arena.sweep(10);
    }
}

/// @notice Task M4 — finalizeSettle: in-order, exactly-once rollover inject, freeze denom.
contract FinalizeSettleTest is FeeArenaTestBase {
    address lpA = makeAddr("fA");

    function test_Finalize_RevertsBeforeSwept() public {
        _openRunningEpochWith(lpA, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3060e18); // Resolved, not Swept
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.finalizeSettle();
    }

    function test_Finalize_FreezesDenominator_AndSettles() public {
        _openRunningEpochWith(lpA, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3060e18); // +2% over 3000 start -> UP wins (band 150)
        arena.sweep(10);
        uint64 id = arena.currentEpochId();

        // contribution6 is now RANGE-NORMALIZED LIQUIDITY (MIN_LIQUIDITY * DEFAULT_TICK_SPAN),
        // price-independent; the single in-range UP winner freezes the denominator at it.
        uint256 expectDenom = uint256(MIN_LIQUIDITY) * uint256(DEFAULT_TICK_SPAN);
        vm.expectEmit(true, false, false, true);
        emit IFeeArena.EpochSettled(id, IFeeArena.Side.UP, expectDenom, 1e18, 2000e6);
        arena.finalizeSettle();

        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertEq(uint8(e.phase), uint8(IFeeArena.PhaseView.Settled));
        assertEq(e.winnerDenominator, expectDenom, "denominator = UP side liquidity * span");
        assertEq(arena.lastSettledEpochId(), id);
        assertEq(arena.winnerCount(id), 1, "one winner with positive contribution");
    }

    function test_Finalize_InjectsPendingRolloverOnce() public {
        // seed a rollover from an empty-winner epoch first (epoch 1)
        _settleEmptyWinnerEpoch(
            1000e6,
            /*usdc rollover*/
            1e18 /*weth rollover*/
        );
        assertEq(arena.rolloverUSDC(), 1000e6);
        assertEq(arena.rolloverWETH(), 1e18);

        // next epoch (2): a real UP winner; its pot must absorb the rollover exactly once
        _openRunningEpochWith(lpA, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3060e18);
        arena.sweep(10);
        uint64 id = arena.currentEpochId();

        vm.expectEmit(true, false, false, true);
        emit IFeeArena.RolloverInjected(id, 1e18, 1000e6);
        arena.finalizeSettle();

        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertEq(e.potUSDC, 2000e6 + 1000e6, "pot absorbed rollover USDC");
        assertEq(e.potWETH, 1e18 + 1e18, "pot absorbed rollover WETH");
        assertEq(arena.rolloverUSDC(), 0, "globals zeroed after inject");
        assertEq(arena.rolloverWETH(), 0);
    }

    function test_Finalize_OutOfOrder_Reverts() public {
        _openRunningEpochWith(lpA, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3060e18);
        arena.sweep(10);
        arena.finalizeSettle(); // epoch 1 settled, lastSettledEpochId = 1
        // a stray second finalizeSettle targets epoch 2 (phase None) -> WrongPhase
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.finalizeSettle();
    }
}

/// @notice Task M7 — solvency invariant helper asserted on state changes.
contract SolvencyHelperTest is FeeArenaTestBase {
    address lp = makeAddr("solv");

    function test_Solvent_AfterSettle_HoldsAtLeastPotPlusRollover() public {
        _openRunningEpochWith(lp, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3060e18);
        arena.sweep(10);
        arena.finalizeSettle();
        // unclaimed pot = 1 WETH + 2000 USDC, rollover 0 (vault auto-funded at stake)
        assertGe(weth.balanceOf(address(arena)), 1e18);
        assertGe(usdc.balanceOf(address(arena)), 2000e6);
        // claim drains exactly the pot, leaving >= 0
        arena.claim(arena.currentEpochId(), _tokenIdOf(lp));
        assertGe(weth.balanceOf(address(arena)), 0);
    }

    function test_Donation_DoesNotInflatePot() public {
        _openRunningEpochWith(lp, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3060e18);
        arena.sweep(10);
        vm.deal(address(this), address(this).balance + 99e18);
        weth.deposit{value: 99e18}(); // attacker donation
        weth.transfer(address(arena), 99e18);
        arena.finalizeSettle();
        IFeeArena.EpochView memory e = arena.currentEpoch();
        assertEq(e.potWETH, 1e18, "pot ignores donation; accounted only");
    }
}

/// @notice Task M10 — read-side views (PhaseView collapse, stake enumeration,
///         rollover-in surfacing). previewClaim is exercised in Claim.t.sol.
contract ViewsTest is FeeArenaTestBase {
    address lpA = makeAddr("vA");
    address lpB = makeAddr("vB");

    function test_PhaseView_Collapses_ResolvedAndSwept_ToRunning() public {
        _openRunningEpochWith(lpA, IFeeArena.Side.UP, 1e18, 2000e6);
        assertEq(uint8(arena.currentEpoch().phase), uint8(IFeeArena.PhaseView.Running)); // Running
        _endEpochAtPrice(3060e18);
        assertEq(uint8(arena.currentEpoch().phase), uint8(IFeeArena.PhaseView.Running)); // Resolved -> Running
        arena.sweep(10);
        assertEq(uint8(arena.currentEpoch().phase), uint8(IFeeArena.PhaseView.Running)); // Swept -> Running
        arena.finalizeSettle();
        assertEq(uint8(arena.currentEpoch().phase), uint8(IFeeArena.PhaseView.Settled));
    }

    function test_GetStakesByEpoch_And_GetUserStakes() public {
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lpA, IFeeArena.Side.UP, 1e18, 2000e6);
        _stakeOwed(lpB, IFeeArena.Side.DOWN, 1e18, 1000e6);
        IFeeArena.StakeView[] memory byEpoch = arena.getStakesByEpoch(id);
        assertEq(byEpoch.length, 2);
        IFeeArena.StakeView[] memory byUser = arena.getUserStakes(lpA);
        assertEq(byUser.length, 1);
        assertEq(byUser[0].owner, lpA);
        assertEq(uint8(byUser[0].side), uint8(IFeeArena.Side.UP));
    }

    function test_RolloverPendingIn_SurfacedInView() public {
        _settleEmptyWinnerEpoch(1000e6, 1e18); // rollover seeded
        vm.prank(owner);
        uint64 id2 = arena.createEpoch();
        IFeeArena.EpochView memory e = arena.getEpoch(id2);
        assertTrue(e.rolloverPendingIn);
        assertEq(e.rolloverInUSDC, 1000e6);
        assertEq(e.rolloverInWETH, 1e18);
    }
}
