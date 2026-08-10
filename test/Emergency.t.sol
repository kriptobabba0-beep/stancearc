// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";

/// @notice Task M9 — emergencySettle terminal escape hatch after endTime + GRACE.
contract EmergencyTest is FeeArenaTestBase {
    address lp = makeAddr("wedged");

    /// @dev Wedge an epoch in Running (no endEpoch) and warp past endTime + GRACE.
    function _wedgeRunningEpochPastGrace() internal returns (uint64 id) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lp, IFeeArena.Side.UP, 1e18, 2000e6);
        _startCurrentAt(3000e18); // Running
        // do NOT endEpoch (oracle wedged); warp past endTime + GRACE
        _warpPast(uint256(arena.getEpoch(id).endTime) + arena.GRACE() + 1);
    }

    function test_EmergencySettle_OnlyOwner() public {
        uint64 id = _wedgeRunningEpochPastGrace();
        vm.prank(makeAddr("x"));
        vm.expectRevert(); // Ownable: caller is not the owner
        arena.emergencySettle(id, IFeeArena.Side.RANGE);
    }

    function test_EmergencySettle_BeforeGrace_Reverts() public {
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lp, IFeeArena.Side.UP, 1e18, 2000e6);
        _startCurrentAt(3000e18);
        // only just past endTime, NOT past GRACE
        _warpPast(uint256(arena.getEpoch(id).endTime) + 1);
        vm.prank(owner);
        vm.expectRevert(IFeeArena.GraceNotElapsed.selector);
        arena.emergencySettle(id, IFeeArena.Side.RANGE);
    }

    function test_EmergencySettle_RollsPot_AndAllowsUnstake() public {
        uint64 id = _wedgeRunningEpochPastGrace();
        vm.expectEmit(true, false, false, true);
        emit IFeeArena.EmergencySettled(id, IFeeArena.Side.RANGE);
        vm.prank(owner);
        arena.emergencySettle(id, IFeeArena.Side.RANGE);

        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertEq(uint8(e.phase), uint8(IFeeArena.PhaseView.Settled));
        assertTrue(e.rolledOver, "emergency rolls pot, no division");
        // NFT recoverable: position marked swept by emergency, unstake succeeds
        vm.prank(lp);
        arena.unstake(_tokenIdOf(lp));
        assertEq(npm.ownerOf(_tokenIdOf(lp)), lp, "NFT returned");
    }

    function test_EmergencySettle_ClaimReverts_AlreadyRolledOver() public {
        uint64 id = _wedgeRunningEpochPastGrace();
        vm.prank(owner);
        arena.emergencySettle(id, IFeeArena.Side.UP);
        // even if resolution matches a staker's side, a wedged epoch pays nothing
        vm.expectRevert(IFeeArena.AlreadyRolledOver.selector);
        arena.claim(id, _tokenIdOf(lp));
    }

    /// @notice A genuinely-resolved epoch (endEpoch ran, settlePrice18 != 0) has a determined
    ///         winner; the owner must NOT be able to roll its pot via emergencySettle even
    ///         after GRACE. Guarded by the new `settlePrice18 != 0` check.
    function test_emergencySettle_reverts_on_resolved_epoch() public {
        uint64 id = _openRunningEpochWith(lp, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3060e18); // Running -> Resolved, settlePrice18 set
        // warp past endTime + GRACE so only the resolution guard can block it
        _warpPast(uint256(arena.getEpoch(id).endTime) + arena.GRACE() + 1);
        vm.prank(owner);
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.emergencySettle(id, IFeeArena.Side.UP);
    }

    /// @notice The owner cannot pause()->wedge->emergencySettle: emergencySettle is whenNotPaused,
    ///         so a paused contract reverts the OZ Pausable error (OZ 4.9 -> "Pausable: paused").
    function test_emergencySettle_reverts_when_paused() public {
        uint64 id = _wedgeRunningEpochPastGrace();
        vm.prank(owner);
        arena.pause();
        vm.prank(owner);
        vm.expectRevert(bytes("Pausable: paused"));
        arena.emergencySettle(id, IFeeArena.Side.RANGE);
    }
}
