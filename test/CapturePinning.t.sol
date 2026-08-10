// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

contract CapturePinningTest is FeeArenaTestBase {
    function test_startEpoch_rejects_price_published_before_entryClose() public {
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        IFeeArena.EpochView memory e = arena.getEpoch(arena.currentEpochId());
        // Stamp a price BEFORE entry closed, then warp past entryClose and try to start.
        vm.warp(uint256(e.entryCloseTime) - 1);
        _setOraclePrice(3000e18); // updatedAt == entryCloseTime - 1
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        vm.expectRevert(IFeeArena.StartPriceTooOld.selector);
        arena.startEpoch(new bytes[](0));
    }

    function test_endEpoch_rejects_price_published_before_endTime() public {
        uint64 id = _createOpenStart(3000e18); // Running; start price stamped >= entryClose
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        vm.warp(uint256(e.endTime) - 1);
        _setOraclePrice(3060e18); // updatedAt == endTime - 1
        vm.warp(uint256(e.endTime));
        vm.expectRevert(IFeeArena.SettlePriceTooOld.selector);
        arena.endEpoch(new bytes[](0));
    }

    function test_pinning_passes_when_price_published_at_or_after_boundary() public {
        // Sanity: the normal helper flow (warp THEN setPrice THEN crank) must still succeed.
        uint64 id = _createOpenStart(3000e18);
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        vm.warp(uint256(e.endTime));
        _setOraclePrice(3060e18); // updatedAt == endTime (>= endTime, allowed)
        arena.endEpoch(new bytes[](0));
        // endEpoch flips Phase.Running -> Phase.Resolved, which collapses to PhaseView.Running
        // (sweep/finalizeSettle are required before the view reports Settled).
        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArena.PhaseView.Running));
    }
}
