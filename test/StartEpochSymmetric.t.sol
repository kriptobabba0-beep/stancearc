// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

contract StartEpochSymmetricTest is FeeArenaTestBase {
    function test_startEpoch_accepts_empty_priceData_and_runs() public {
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        IFeeArena.EpochView memory e = arena.getEpoch(arena.currentEpochId());
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        _setOraclePrice(3000e18);
        arena.startEpoch{value: 0}(new bytes[](0));
        assertEq(uint8(arena.getEpoch(e.epochId).phase), uint8(IFeeArena.PhaseView.Running));
    }
}
