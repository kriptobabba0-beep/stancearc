// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "../utils/FeeArenaTestBase.sol";
import {DemoFlow} from "../../script/DemoFlow.s.sol";
import {FeeArena} from "../../src/FeeArena.sol";
import {IFeeArena} from "../../src/interfaces/IFeeArena.sol";

/// @notice Unit-tests DemoFlow's pure preset + hook-driven branch runners against the MOCK
///         FeeArena fixture (FeeArenaTestBase). The hooks mint+stake mock positions and program
///         owed fees AFTER staking (onERC721Received zeroes the pre-stake fee baseline), so the
///         swept pot is non-zero. The self-contained real-V3 `run()` path is exercised separately
///         by `forge script script/DemoFlow.s.sol`.
contract DemoFlowTest is FeeArenaTestBase {
    DemoFlow internal demo;

    // staked tokenIds recorded by the hooks, so `runSwaps` can program owed fees post-stake.
    uint256[] internal stakedIds;
    mapping(address => uint256) internal tokenOf;

    function setUp() public override {
        super.setUp();
        demo = new DemoFlow();
    }

    // ---- hook implementations (external; match DemoFlow.Hooks pointer signatures) ----

    function _hookUp(address lp) external returns (uint256 id) {
        return _stakeFor(lp, IFeeArena.Side.UP);
    }

    function _hookDown(address lp) external returns (uint256 id) {
        return _stakeFor(lp, IFeeArena.Side.DOWN);
    }

    function _hookRange(address lp) external returns (uint256 id) {
        return _stakeFor(lp, IFeeArena.Side.RANGE);
    }

    /// @dev Program owed fees on the CURRENT epoch's freshly-staked positions (called as the
    ///      `runSwaps` hook, AFTER startEpoch — i.e. after onERC721Received's collect() zeroed
    ///      the baseline). Only un-swept positions of the current epoch are touched so the
    ///      empty-winner branch's two internal cycles don't re-program prior-epoch tokens.
    function _hookSwaps() external {
        uint64 cur = arena.currentEpochId();
        for (uint256 i = 0; i < stakedIds.length; ++i) {
            IFeeArena.StakeView memory s = arena.getStake(stakedIds[i]);
            if (s.epochId == cur && !s.swept) {
                _programOwed(stakedIds[i], 1e16, 30e6); // 0.01 WETH + 30 USDC owed per position
            }
        }
    }

    function _stakeFor(address lp, IFeeArena.Side side) internal returns (uint256 id) {
        id = _mintPosition(lp, MIN_LIQUIDITY);
        vm.roll(block.number + 1); // one-action-per-block guard across stakers
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), id, abi.encode(side));
        stakedIds.push(id);
        tokenOf[lp] = id;
    }

    function _baseHooks() internal view returns (DemoFlow.Hooks memory) {
        return DemoFlow.Hooks({
            mintAndStakeUp: this._hookUp,
            mintAndStakeDown: this._hookDown,
            mintAndStakeRange: this._hookRange,
            runSwaps: this._hookSwaps
        });
    }

    function stakeTokenOf(address lp) public view returns (uint256) {
        return tokenOf[lp];
    }

    // ---- D5: pure preset arithmetic ----

    function test_DemoFlow_ForcePreset_UP_DOWN_RANGE_Arithmetic() public view {
        uint256 start = 3000e18;
        int32 band = 150;
        assertGt(demo.forcePrice(start, band, IFeeArena.Side.UP), start, "UP > start");
        assertLt(demo.forcePrice(start, band, IFeeArena.Side.DOWN), start, "DOWN < start");
        assertEq(demo.forcePrice(start, band, IFeeArena.Side.RANGE), start, "RANGE == start");

        uint256 up = demo.forcePrice(start, band, IFeeArena.Side.UP);
        assertGt((up - start) * 10000 / start, uint256(uint32(band)), "UP clears band");
        uint256 down = demo.forcePrice(start, band, IFeeArena.Side.DOWN);
        assertGt((start - down) * 10000 / start, uint256(uint32(band)), "DOWN clears band");
    }

    // ---- D5: UP-win end-to-end ----

    function test_DemoFlow_UpWin_EndToEnd() public {
        DemoFlow.Actors memory actors = DemoFlow.Actors({
            lpUp1: makeAddr("lpA"), lpUp2: makeAddr("lpB"), lpDown: makeAddr("lpC"), lpRange: makeAddr("lpD")
        });

        uint64 epochId = demo.runUpWin(address(arena), address(oracle), owner, actors, _baseHooks());

        IFeeArena.EpochView memory ev = arena.getEpoch(epochId);
        assertEq(uint8(ev.phase), uint8(IFeeArena.PhaseView.Settled), "settled");
        assertEq(uint8(ev.winningSide), uint8(IFeeArena.Side.UP), "UP wins");
        assertGt(ev.winnerDenominator, 0, "non-empty winner");

        // winners A,B can claim; loser C reverts WrongSide
        uint256 idA = stakeTokenOf(actors.lpUp1);
        uint256 idC = stakeTokenOf(actors.lpDown);
        vm.prank(actors.lpUp1);
        arena.claim(epochId, idA);
        assertTrue(arena.getStake(idA).claimed, "A claimed");

        vm.expectRevert(IFeeArena.WrongSide.selector);
        arena.claim(epochId, idC);
    }

    // ---- D6: DOWN-win ----

    function test_DemoFlow_DownWin() public {
        DemoFlow.Actors memory actors = DemoFlow.Actors({
            lpUp1: makeAddr("u1"), lpUp2: makeAddr("u2"), lpDown: makeAddr("d"), lpRange: makeAddr("r")
        });
        uint64 id = demo.runDownWin(address(arena), address(oracle), owner, actors, _baseHooks());
        IFeeArena.EpochView memory ev = arena.getEpoch(id);
        assertEq(uint8(ev.winningSide), uint8(IFeeArena.Side.DOWN), "DOWN wins");
        assertEq(uint8(ev.phase), uint8(IFeeArena.PhaseView.Settled), "settled");
        assertGt(ev.winnerDenominator, 0, "non-empty winner");
    }

    // ---- D6: RANGE-win ----

    function test_DemoFlow_RangeWin() public {
        DemoFlow.Actors memory actors = DemoFlow.Actors({
            lpUp1: makeAddr("u1"), lpUp2: makeAddr("u2"), lpDown: makeAddr("d"), lpRange: makeAddr("r")
        });
        uint64 id = demo.runRangeWin(address(arena), address(oracle), owner, actors, _baseHooks());
        IFeeArena.EpochView memory ev = arena.getEpoch(id);
        assertEq(uint8(ev.winningSide), uint8(IFeeArena.Side.RANGE), "RANGE wins");
        assertEq(uint8(ev.phase), uint8(IFeeArena.PhaseView.Settled), "settled");
        assertGt(ev.winnerDenominator, 0, "non-empty winner");
    }

    // ---- D6: empty-winner rollover into the next epoch ----

    function test_DemoFlow_EmptyWinner_RollsToNextEpoch() public {
        DemoFlow.Actors memory actors = DemoFlow.Actors({
            lpUp1: makeAddr("u1"), lpUp2: makeAddr("u2"), lpDown: makeAddr("d"), lpRange: makeAddr("r")
        });
        (uint64 e1, uint64 e2) =
            demo.runEmptyWinnerThenNormal(address(arena), address(oracle), owner, actors, _baseHooks());

        IFeeArena.EpochView memory ev1 = arena.getEpoch(e1);
        assertTrue(ev1.rolledOver, "epoch1 rolled over");
        assertEq(ev1.winnerDenominator, 0, "epoch1 empty winner");

        IFeeArena.EpochView memory ev2 = arena.getEpoch(e2);
        assertEq(uint8(ev2.phase), uint8(IFeeArena.PhaseView.Settled), "epoch2 settled");
        assertGt(ev2.potWETH + ev2.potUSDC, 0, "epoch2 pot includes rollover");
        // after injection the global rollover is consumed exactly once
        assertEq(arena.rolloverWETH(), 0, "rolloverWETH consumed");
        assertEq(arena.rolloverUSDC(), 0, "rolloverUSDC consumed");
    }
}
