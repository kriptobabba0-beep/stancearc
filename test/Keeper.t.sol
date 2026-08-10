// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @title Keeper role — least-privilege lifecycle driver (createEpoch + openEntry only).
/// @notice The owner-settable `keeper` may run the epoch LIFECYCLE but NOTHING else: no
///         config setters, no pause/unpause, no emergencySettle, no setKeeper, no funds.
///         The owner stays able to do everything (owner ∈ allowed). The base fixture already
///         declares `owner` and a `keeper` address member — reused here.
contract KeeperTest is FeeArenaTestBase {
    event KeeperUpdated(address indexed previousKeeper, address indexed newKeeper);

    address internal stranger = makeAddr("stranger");

    /// @dev Baseline (unchanged): the owner can still create + open epochs.
    function test_owner_can_create_and_open() public {
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        assertEq(uint256(id), 1);
        vm.prank(owner);
        arena.openEntry();
        assertEq(uint8(arena.currentEpoch().phase), uint8(IFeeArena.PhaseView.EntryOpen));
    }

    /// @dev Owner sets a keeper; the keeper can then run the lifecycle.
    function test_setKeeper_then_keeper_can_create_and_open() public {
        vm.prank(owner);
        arena.setKeeper(keeper);
        assertEq(arena.keeper(), keeper);

        vm.prank(keeper);
        uint64 id = arena.createEpoch();
        assertEq(uint256(id), 1);

        vm.prank(keeper);
        arena.openEntry();
        assertEq(uint8(arena.currentEpoch().phase), uint8(IFeeArena.PhaseView.EntryOpen));
    }

    /// @dev A non-owner, non-keeper address cannot create or open: NotOwnerOrKeeper.
    function test_random_cannot_create_or_open() public {
        // create reverts
        vm.prank(stranger);
        vm.expectRevert(IFeeArena.NotOwnerOrKeeper.selector);
        arena.createEpoch();

        // even after the owner has created epoch #1, a stranger cannot open it
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(stranger);
        vm.expectRevert(IFeeArena.NotOwnerOrKeeper.selector);
        arena.openEntry();
    }

    /// @dev The keeper is least-privilege: it can run the lifecycle but NOTHING admin.
    ///      Admin calls revert with Ownable's "caller is not the owner" (NOT NotOwnerOrKeeper,
    ///      which is exclusive to create/open).
    function test_keeper_cannot_admin() public {
        vm.prank(owner);
        arena.setKeeper(keeper);

        bytes memory ownableErr = bytes("Ownable: caller is not the owner");

        // setKeeper (rotate/clear) — owner only
        vm.prank(keeper);
        vm.expectRevert(ownableErr);
        arena.setKeeper(stranger);

        // band config
        vm.prank(keeper);
        vm.expectRevert(ownableErr);
        arena.setBand(200);

        // timing config
        vm.prank(keeper);
        vm.expectRevert(ownableErr);
        arena.setTiming(ENTRY_WINDOW, EPOCH_DURATION, MIN_START_GAP, MAX_START_DELAY, MAX_PRICE_AGE);

        // stake caps config
        vm.prank(keeper);
        vm.expectRevert(ownableErr);
        arena.setStakeCaps(10, 5);

        // pause
        vm.prank(keeper);
        vm.expectRevert(ownableErr);
        arena.pause();

        // emergencySettle (needs an epoch to target; the onlyOwner gate trips first anyway)
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(keeper);
        vm.expectRevert(ownableErr);
        arena.emergencySettle(1, IFeeArena.Side.UP);

        // sanity: the keeper's actual privilege (lifecycle) still works after epoch #1 exists
        vm.prank(keeper);
        arena.openEntry();
        assertEq(uint8(arena.currentEpoch().phase), uint8(IFeeArena.PhaseView.EntryOpen));
    }

    /// @dev setKeeper is owner-only; clearing to address(0) revokes the ex-keeper.
    function test_setKeeper_is_owner_only() public {
        // keeper cannot set itself / anyone as keeper
        vm.prank(keeper);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        arena.setKeeper(keeper);

        // owner can set it
        vm.prank(owner);
        arena.setKeeper(keeper);
        assertEq(arena.keeper(), keeper);

        // ex-keeper can create while set
        vm.prank(keeper);
        arena.createEpoch();
        vm.prank(keeper);
        arena.openEntry();

        // owner clears the keeper (address(0))
        vm.prank(owner);
        arena.setKeeper(address(0));
        assertEq(arena.keeper(), address(0));

        // ex-keeper can no longer drive the lifecycle (NotOwnerOrKeeper)
        // first settle epoch #1 so a fresh createEpoch is even sequencing-eligible — but the
        // auth gate trips before any sequencing check, so we just assert the revert directly.
        vm.prank(keeper);
        vm.expectRevert(IFeeArena.NotOwnerOrKeeper.selector);
        arena.createEpoch();
    }

    /// @dev setKeeper emits KeeperUpdated(previous, next).
    function test_KeeperUpdated_event() public {
        // initial set: previous == address(0)
        vm.expectEmit(true, true, false, false, address(arena));
        emit KeeperUpdated(address(0), keeper);
        vm.prank(owner);
        arena.setKeeper(keeper);

        // rotate: previous == keeper, next == stranger
        vm.expectEmit(true, true, false, false, address(arena));
        emit KeeperUpdated(keeper, stranger);
        vm.prank(owner);
        arena.setKeeper(stranger);
    }
}
