// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";

/// @notice Task M8 — pause gates stake + cranks; claim/unstake/foldDust stay open
///         (user funds and NFTs are never frozen).
contract PausableTest is FeeArenaTestBase {
    address lp = makeAddr("pauseLp");

    function test_OnlyOwner_CanPause() public {
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(); // OZ Ownable: caller is not the owner
        arena.pause();
    }

    function test_Pause_Blocks_Sweep() public {
        _openRunningEpochWith(lp, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3060e18);
        vm.prank(owner);
        arena.pause();
        vm.expectRevert(); // Pausable: paused
        arena.sweep(10);
    }

    function test_Pause_Blocks_Stake() public {
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        vm.prank(owner);
        arena.pause();
        uint256 tokenId = _mintPosition(lp, MIN_LIQUIDITY);
        vm.prank(lp);
        vm.expectRevert(); // Pausable: paused (onERC721Received whenNotPaused)
        npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(IFeeArena.Side.UP));
    }

    function test_Pause_AllowsClaimAndUnstake() public {
        // settle fully, then pause, then claim + unstake must still work
        _openRunningEpochWith(lp, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3060e18);
        arena.sweep(10);
        arena.finalizeSettle();
        uint64 id = arena.currentEpochId();

        vm.prank(owner);
        arena.pause();
        arena.claim(id, _tokenIdOf(lp)); // must NOT revert
        vm.prank(lp);
        arena.unstake(_tokenIdOf(lp)); // must NOT revert (funds/NFTs never frozen)
        assertEq(npm.ownerOf(_tokenIdOf(lp)), lp, "NFT returned while paused");
    }

    function test_Unpause_RestoresCranks() public {
        vm.prank(owner);
        arena.pause();
        vm.prank(owner);
        arena.unpause();
        assertFalse(arena.paused());
    }
}
