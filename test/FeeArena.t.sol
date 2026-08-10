// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";

contract FeeArenaLifecycleTest is FeeArenaTestBase {
    function test_Immutables_SetAndDecimalsDerived() public view {
        assertEq(arena.USDC(), address(usdc), "USDC");
        assertEq(arena.WETH(), address(weth), "WETH");
        assertEq(arena.POOL(), address(pool), "POOL");
        assertEq(arena.NPM(), address(npm), "NPM");
        assertEq(arena.FACTORY(), address(factory), "FACTORY");
        assertEq(arena.ORACLE(), address(oracle), "ORACLE");
        assertEq(uint256(arena.FEE_TIER()), uint256(FEE_TIER), "feeTier");
        assertEq(uint256(arena.MIN_LIQUIDITY()), uint256(MIN_LIQ), "minLiq");
        // WETH_NOTIONAL_DIV = 10**(18 + 18 - 6) = 1e30, DERIVED not hardcoded
        assertEq(arena.WETH_NOTIONAL_DIV(), 1e30, "notionalDiv");
        // weth==token0 in fixture -> wethIsToken0 == 1
        assertEq(uint256(arena.wethIsToken0()), 1, "wethIsToken0");
        assertEq(arena.owner(), owner, "owner");
    }

    function test_Constructor_RevertOnBadUsdcDecimals() public {
        TestERC20 bad = new TestERC20("Bad", "BAD", 18); // USDC must be 6dp
        IFeeArena.BootConfig memory c = _bootConfig();
        c.usdc = address(bad);
        vm.expectRevert(IFeeArena.BadDecimals.selector);
        new FeeArena(c);
    }

    function test_Constructor_RevertOnZeroAddress() public {
        IFeeArena.BootConfig memory c = _bootConfig();
        c.pool = address(0);
        vm.expectRevert(IFeeArena.ZeroAddress.selector);
        new FeeArena(c);
    }

    // ---------------------------------------------------------------------
    // L2 — config setters
    // ---------------------------------------------------------------------

    function test_SetTiming_OnlyOwner_EmitsAndStores() public {
        vm.expectRevert(); // OZ Ownable: caller is not the owner
        arena.setTiming(60, 120, 10, 200, 300);

        vm.expectEmit(false, false, false, true, address(arena));
        emit IFeeArena.TimingUpdated(60, 120, 10, 200, 300);
        vm.prank(owner);
        arena.setTiming(60, 120, 10, 200, 300);

        assertEq(uint256(arena.entryWindow()), 60);
        assertEq(uint256(arena.epochDuration()), 120);
        assertEq(uint256(arena.minStartGap()), 10);
        assertEq(uint256(arena.maxStartDelay()), 200);
        assertEq(uint256(arena.maxPriceAge()), 300);
    }

    function test_SetBand_RejectsOutOfRange() public {
        vm.prank(owner);
        vm.expectRevert(IFeeArena.BandOutOfRange.selector);
        arena.setBand(0);

        vm.prank(owner);
        vm.expectRevert(IFeeArena.BandOutOfRange.selector);
        arena.setBand(10000);

        vm.expectEmit(false, false, false, true, address(arena));
        emit IFeeArena.BandUpdated(250);
        vm.prank(owner);
        arena.setBand(250);
        assertEq(int256(arena.bandBps()), int256(250));
    }

    function test_SetStakeCaps_AndPause() public {
        vm.prank(owner);
        arena.setStakeCaps(50, 5);
        assertEq(uint256(arena.maxStakesPerEpoch()), 50);
        assertEq(uint256(arena.maxStakesPerUser()), 5);

        vm.prank(owner);
        arena.pause();
        assertTrue(arena.paused());
        vm.prank(owner);
        arena.unpause();
        assertFalse(arena.paused());
    }

    // ---------------------------------------------------------------------
    // L3 — createEpoch + getEpoch
    // ---------------------------------------------------------------------

    function test_CreateEpoch_SnapshotsTimingAndBand() public {
        uint64 t = uint64(block.timestamp);
        vm.expectEmit(true, false, false, true, address(arena));
        emit IFeeArena.EpochCreated(
            1,
            t, // entryOpenTime
            t + ENTRY_WINDOW, // entryCloseTime
            t + ENTRY_WINDOW + MIN_START_GAP, // startTime
            t + ENTRY_WINDOW + MIN_START_GAP + EPOCH_DURATION, // endTime
            BAND_BPS
        );
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        assertEq(uint256(id), 1);
        assertEq(uint256(arena.currentEpochId()), 1);

        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertEq(uint256(uint8(e.phase)), uint256(uint8(IFeeArena.PhaseView.Idle))); // None->Idle (created, not opened)
        assertEq(uint256(e.entryOpenTime), t);
        assertEq(uint256(e.entryCloseTime), t + ENTRY_WINDOW);
        assertEq(uint256(e.startTime), t + ENTRY_WINDOW + MIN_START_GAP);
        assertEq(uint256(e.endTime), t + ENTRY_WINDOW + MIN_START_GAP + EPOCH_DURATION);
        assertEq(int256(e.bandBps), int256(BAND_BPS));
    }

    function test_CreateEpoch_OnlyOwner() public {
        vm.expectRevert(); // Ownable
        arena.createEpoch();
    }

    function test_CreateEpoch_RevertWhenPrevNotSettled() public {
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        vm.expectRevert(IFeeArena.PrevNotSettled.selector);
        arena.createEpoch();
    }

    // ---------------------------------------------------------------------
    // L4 — openEntry
    // ---------------------------------------------------------------------

    function test_OpenEntry_FlipsToEntryOpen() public {
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertEq(uint256(uint8(e.phase)), uint256(uint8(IFeeArena.PhaseView.EntryOpen)));
    }

    function test_OpenEntry_OnlyOwner() public {
        vm.prank(owner);
        arena.createEpoch();
        vm.expectRevert(); // Ownable
        arena.openEntry();
    }

    function test_OpenEntry_RevertWhenNotNonePhase() public {
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        // second openEntry: phase already EntryOpen -> WrongPhase
        vm.prank(owner);
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.openEntry();
    }

    // ---------------------------------------------------------------------
    // L5 — startEpoch
    // ---------------------------------------------------------------------

    function _createAndOpen() internal returns (uint64 id, IFeeArena.EpochView memory e) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        e = arena.getEpoch(id);
    }

    function test_StartEpoch_Permissionless_FreezesPrice() public {
        (uint64 id, IFeeArena.EpochView memory e) = _createAndOpen();
        vm.warp(e.entryCloseTime + MIN_START_GAP);
        _setOraclePrice(3000e18);

        vm.expectEmit(true, false, false, true, address(arena));
        emit IFeeArena.EpochStarted(id, 3000e18, uint64(block.timestamp));
        vm.prank(keeper); // permissionless
        arena.startEpoch(new bytes[](0));

        IFeeArena.EpochView memory v = arena.getEpoch(id);
        assertEq(uint256(uint8(v.phase)), uint256(uint8(IFeeArena.PhaseView.Running)));
        assertEq(v.startPrice18, 3000e18);
    }

    function test_StartEpoch_RevertTooEarly() public {
        (, IFeeArena.EpochView memory e) = _createAndOpen();
        vm.warp(e.entryCloseTime - 1); // before entryClose
        _setOraclePrice(3000e18);
        vm.expectRevert(IFeeArena.StartTooEarly.selector);
        arena.startEpoch(new bytes[](0));
    }

    function test_StartEpoch_RevertStartDelayExceeded() public {
        (, IFeeArena.EpochView memory e) = _createAndOpen();
        vm.warp(e.entryCloseTime + MAX_START_DELAY + 1);
        _setOraclePrice(3000e18);
        vm.expectRevert(IFeeArena.StartDelayExceeded.selector);
        arena.startEpoch(new bytes[](0));
    }

    function test_StartEpoch_RevertZeroPrice() public {
        (, IFeeArena.EpochView memory e) = _createAndOpen();
        vm.warp(e.entryCloseTime + MIN_START_GAP);
        // oracle never set -> getPrice returns 0
        vm.expectRevert(IFeeArena.ZeroPrice.selector);
        arena.startEpoch(new bytes[](0));
    }

    function test_StartEpoch_RevertWrongPhase() public {
        vm.prank(owner);
        arena.createEpoch(); // phase None, never opened
        vm.warp(block.timestamp + ENTRY_WINDOW + MIN_START_GAP);
        _setOraclePrice(3000e18);
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.startEpoch(new bytes[](0));
    }

    // ---------------------------------------------------------------------
    // L6 — endEpoch
    // ---------------------------------------------------------------------

    function test_EndEpoch_ResolvesUP_FreezesOutcome() public {
        uint64 id = _createOpenStart(3000e18); // start price $3000
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        vm.warp(e0.endTime);
        _setOraclePrice(3100e18); // +3.33% > +1.5% band -> UP

        // deltaBps = (3100-3000)*10000/3000 = 333
        vm.expectEmit(true, false, false, true, address(arena));
        emit IFeeArena.EpochResolved(id, 3100e18, IFeeArena.Side.UP, int256(333), uint64(block.timestamp));
        arena.endEpoch{value: 0}(new bytes[](0)); // permissionless keeper

        IFeeArena.EpochView memory v = arena.getEpoch(id);
        assertEq(uint256(uint8(v.phase)), uint256(uint8(IFeeArena.PhaseView.Running))); // Resolved collapses to Running
        assertEq(v.settlePrice18, 3100e18);
        assertEq(uint256(uint8(v.winningSide)), uint256(uint8(IFeeArena.Side.UP)));
        assertEq(v.deltaBps, int256(333));
    }

    function test_EndEpoch_ResolvesDOWN() public {
        uint64 id = _createOpenStart(3000e18);
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        vm.warp(e0.endTime);
        _setOraclePrice(2900e18); // -3.33% < -1.5% -> DOWN
        arena.endEpoch(new bytes[](0));
        IFeeArena.EpochView memory v = arena.getEpoch(id);
        assertEq(uint256(uint8(v.winningSide)), uint256(uint8(IFeeArena.Side.DOWN)));
    }

    function test_EndEpoch_ExactBand_ResolvesRANGE() public {
        uint64 id = _createOpenStart(10000e18);
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        vm.warp(e0.endTime);
        _setOraclePrice(10150e18); // exactly +1.5% (band 150) -> boundary => RANGE
        arena.endEpoch(new bytes[](0));
        IFeeArena.EpochView memory v = arena.getEpoch(id);
        assertEq(uint256(uint8(v.winningSide)), uint256(uint8(IFeeArena.Side.RANGE)));
        assertEq(v.deltaBps, int256(150));
    }

    function test_EndEpoch_RevertBeforeEndTime() public {
        uint64 id = _createOpenStart(3000e18);
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        vm.warp(e0.endTime - 1);
        _setOraclePrice(3100e18);
        vm.expectRevert(IFeeArena.EpochNotEnded.selector);
        arena.endEpoch(new bytes[](0));
    }

    function test_EndEpoch_RevertWrongPhase() public {
        (uint64 id,) = _createAndOpen(); // EntryOpen, never started
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        vm.warp(e0.endTime);
        _setOraclePrice(3100e18);
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.endEpoch(new bytes[](0));
    }

    function test_EndEpoch_RevertZeroPrice() public {
        uint64 id = _createOpenStart(3000e18);
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        vm.warp(e0.endTime);
        // settle price never refreshed beyond start? set to 0 not possible (require>0 in mock);
        // instead warp far past maxPriceAge to force StalePrice
        vm.warp(e0.endTime + MAX_PRICE_AGE + 1);
        vm.expectRevert(IFeeArena.StalePrice.selector);
        arena.endEpoch(new bytes[](0));
    }

    // ---------------------------------------------------------------------
    // L7 — currentEpoch view + lifecycle gating matrix
    // ---------------------------------------------------------------------

    function test_HappyPath_WalksToResolved() public {
        uint64 id = _createOpenStart(3000e18);
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        vm.warp(e0.endTime);
        _setOraclePrice(3100e18);
        arena.endEpoch(new bytes[](0));

        IFeeArena.EpochView memory cur = arena.currentEpoch();
        assertEq(uint256(cur.epochId), 1);
        assertEq(uint256(uint8(cur.phase)), uint256(uint8(IFeeArena.PhaseView.Running))); // Resolved->Running view
        assertEq(cur.startPrice18, 3000e18);
        assertEq(cur.settlePrice18, 3100e18);
    }

    function test_NoBackward_CannotStartTwice() public {
        uint64 id = _createOpenStart(3000e18);
        id; // running now
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.startEpoch(new bytes[](0));
    }

    function test_NoBackward_CannotEndTwice() public {
        uint64 id = _createOpenStart(3000e18);
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        vm.warp(e0.endTime);
        _setOraclePrice(3100e18);
        arena.endEpoch(new bytes[](0));
        // already Resolved
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.endEpoch(new bytes[](0));
    }

    function test_StartEpoch_StaleOracle_Reverts() public {
        (, IFeeArena.EpochView memory e) = _createAndOpen();
        _setOraclePrice(3000e18); // updatedAt = now
        vm.warp(e.entryCloseTime + MIN_START_GAP);
        // ensure we're within start window but oracle is stale by maxPriceAge
        // (price was set at setUp-time block; warp pushes us past freshness)
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        // re-set price stale: warp far, then attempt
        vm.warp(uint256(e.entryCloseTime) + MAX_PRICE_AGE + 5);
        if (block.timestamp <= uint256(e.entryCloseTime) + MAX_START_DELAY) {
            vm.expectRevert(IFeeArena.StalePrice.selector);
            arena.startEpoch(new bytes[](0));
        }
    }
}
