// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";

/// @notice A contract staker (smart wallet stand-in) whose onERC721Received behavior is
///         switchable, so the park (reject) -> manual-pull (accept) fallback story can be
///         exercised end-to-end: rejected during the auto-return batch, then flipped to
///         accepting and pulled via the owner-gated unstake().
contract SwitchableReceiver {
    FeeArena internal immutable arena;
    MockNonfungiblePositionManager internal immutable npm;
    bool public accept;

    constructor(FeeArena a, MockNonfungiblePositionManager n) {
        arena = a;
        npm = n;
    }

    function setAccept(bool v) external {
        accept = v;
    }

    function stake(uint256 tokenId, IFeeArena.Side side) external {
        npm.safeTransferFrom(address(this), address(arena), tokenId, abi.encode(side));
    }

    function pull(uint256 tokenId) external {
        arena.unstake(tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(accept, "receiver: reject");
        return 0x150b7a02;
    }
}

/// @notice Receiver whose hook burns all forwarded gas — verifies AUTO_RETURN_GAS caps the
///         damage to the hostile token itself (parked) instead of OOG-ing the whole batch.
contract GasBurnReceiver {
    MockNonfungiblePositionManager internal immutable npm;
    address internal immutable arena;

    constructor(address a, MockNonfungiblePositionManager n) {
        arena = a;
        npm = n;
    }

    function stake(uint256 tokenId, IFeeArena.Side side) external {
        npm.safeTransferFrom(address(this), arena, tokenId, abi.encode(side));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        uint256 x;
        while (true) {
            x += 1; // burn the entire gas stipend
        }
        return 0x150b7a02; // unreachable
    }
}

/// @notice Receiver whose hook tries to re-enter unstakeBatch — the nonReentrant guard must
///         revert the inner call, which reverts the hook, which parks ONLY this receiver.
contract ReentrantReceiver {
    FeeArena internal immutable arena;
    MockNonfungiblePositionManager internal immutable npm;
    uint64 public epochId;

    constructor(FeeArena a, MockNonfungiblePositionManager n) {
        arena = a;
        npm = n;
    }

    function setEpochId(uint64 id) external {
        epochId = id;
    }

    function stake(uint256 tokenId, IFeeArena.Side side) external {
        npm.safeTransferFrom(address(this), address(arena), tokenId, abi.encode(side));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        arena.unstakeBatch(epochId, 10); // must revert (reentrancy lock held)
        return 0x150b7a02;
    }
}

/// @notice Auto-return (push-based unstake): permissionless paginated unstakeBatch that
///         returns escrowed NFTs to owners after Settled, parking (skip + manual-pull
///         fallback) any receiver whose onERC721Received reverts, burns the gas stipend,
///         or re-enters — one bad receiver can never block anyone else's return.
contract AutoUnstakeTest is FeeArenaTestBase {
    address lpA = makeAddr("upWinner");
    address lpB = makeAddr("downLoser");
    address lpC = makeAddr("rangeLoser");
    uint64 id;

    /// @dev (done, total) auto-return progress — the on-chain pair the keeper reads
    ///      (no dedicated view: the contract sits against the EIP-170 size limit).
    function _unstakeProgress(uint64 epochId) internal view returns (uint32 done, uint32 total) {
        done = arena.unstakeCursor(epochId);
        (, total) = arena.sweepProgress(epochId);
    }

    /// @dev Three EOA stakers (UP wins) driven to Settled via the canonical cranks.
    function _settledEpoch3() internal {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lpA, IFeeArena.Side.UP, 1e18, 1000e6);
        _stakeOwed(lpB, IFeeArena.Side.DOWN, 1e18, 1000e6);
        _stakeOwed(lpC, IFeeArena.Side.RANGE, 0, 500e6);
        _startCurrentAt(3000e18);
        _endEpochAtPrice(3300e18); // +10% -> clean UP win
        arena.sweep(10);
        arena.finalizeSettle();
    }

    /// @dev Two EOA stakers sandwiching a contract staker (so park-and-continue is visible).
    function _settledEpochWithReceiver(address receiver) internal returns (uint256 rcvTokenId) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lpA, IFeeArena.Side.UP, 1e18, 1000e6);

        // contract staker in the MIDDLE of the batch order
        rcvTokenId = _mintPosition(receiver, MIN_LIQUIDITY);
        vm.roll(block.number + 1);
        if (receiver.code.length > 0) {
            // the receiver contract pushes its own NFT into the arena (stake())
            (bool ok,) = receiver.call(abi.encodeWithSignature("stake(uint256,uint8)", rcvTokenId, uint8(IFeeArena.Side.DOWN)));
            require(ok, "stake via receiver failed");
        }
        _programOwed(rcvTokenId, 1e18, 250e6);

        vm.roll(block.number + 1);
        _stakeOwed(lpC, IFeeArena.Side.RANGE, 0, 500e6);

        _startCurrentAt(3000e18);
        _endEpochAtPrice(3300e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();
    }

    // ---- happy path ----

    function test_UnstakeBatch_ReturnsAll_ToOwners_Permissionless() public {
        _settledEpoch3();
        vm.prank(makeAddr("stranger")); // anyone may crank
        arena.unstakeBatch(id, 10);

        assertEq(npm.ownerOf(_tokenIdOf(lpA)), lpA, "winner NFT returned");
        assertEq(npm.ownerOf(_tokenIdOf(lpB)), lpB, "loser NFT returned");
        assertEq(npm.ownerOf(_tokenIdOf(lpC)), lpC, "loser NFT returned");
        assertTrue(arena.getStake(_tokenIdOf(lpA)).unstaked);
        assertTrue(arena.getStake(_tokenIdOf(lpB)).unstaked);
        assertTrue(arena.getStake(_tokenIdOf(lpC)).unstaked);

        (uint32 done, uint32 total) = _unstakeProgress(id);
        assertEq(done, 3);
        assertEq(total, 3);
    }

    function test_UnstakeBatch_EmitsUnstakedPerToken_AndProgress() public {
        _settledEpoch3();
        vm.expectEmit(true, true, true, true, address(arena));
        emit IFeeArena.Unstaked(id, lpA, _tokenIdOf(lpA));
        vm.expectEmit(true, true, true, true, address(arena));
        emit IFeeArena.Unstaked(id, lpB, _tokenIdOf(lpB));
        vm.expectEmit(true, true, true, true, address(arena));
        emit IFeeArena.Unstaked(id, lpC, _tokenIdOf(lpC));
        vm.expectEmit(true, false, false, true, address(arena));
        emit IFeeArena.UnstakeProgressed(id, 3, 3);
        arena.unstakeBatch(id, 10);
    }

    function test_UnstakeBatch_Paginated_ResumesFromCursor() public {
        _settledEpoch3();
        arena.unstakeBatch(id, 2);
        (uint32 done,) = _unstakeProgress(id);
        assertEq(done, 2, "first page");
        assertEq(npm.ownerOf(_tokenIdOf(lpA)), lpA);
        assertEq(npm.ownerOf(_tokenIdOf(lpB)), lpB);
        assertEq(npm.ownerOf(_tokenIdOf(lpC)), address(arena), "third still escrowed");

        arena.unstakeBatch(id, 10);
        (done,) = _unstakeProgress(id);
        assertEq(done, 3, "resumed to completion");
        assertEq(npm.ownerOf(_tokenIdOf(lpC)), lpC);
    }

    function test_UnstakeBatch_AfterComplete_IsNoop() public {
        _settledEpoch3();
        arena.unstakeBatch(id, 10);
        arena.unstakeBatch(id, 10); // cursor == total: no iterations, no revert
        (uint32 done, uint32 total) = _unstakeProgress(id);
        assertEq(done, total);
    }

    // ---- gating ----

    function test_UnstakeBatch_BeforeSettled_Reverts() public {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lpA, IFeeArena.Side.UP, 1e18, 1000e6);
        _startCurrentAt(3000e18);
        _endEpochAtPrice(3300e18); // Resolved
        vm.expectRevert(IFeeArena.NotSettled.selector);
        arena.unstakeBatch(id, 10);

        arena.sweep(10); // Swept (still not Settled)
        vm.expectRevert(IFeeArena.NotSettled.selector);
        arena.unstakeBatch(id, 10);
    }

    function test_UnstakeBatch_WhenPaused_Reverts_ButManualUnstakeWorks() public {
        _settledEpoch3();
        vm.prank(owner);
        arena.pause();

        // protocol push is halted by the emergency brake...
        vm.expectRevert(bytes("Pausable: paused"));
        arena.unstakeBatch(id, 10);

        // ...but the user escape hatch (manual pull) stays open while paused.
        vm.prank(lpA);
        arena.unstake(_tokenIdOf(lpA));
        assertEq(npm.ownerOf(_tokenIdOf(lpA)), lpA);
    }

    // ---- interaction with manual unstake + claim ----

    function test_UnstakeBatch_SkipsManuallyUnstaked() public {
        _settledEpoch3();
        vm.prank(lpB);
        arena.unstake(_tokenIdOf(lpB)); // manual pull before the crank

        arena.unstakeBatch(id, 10); // must skip lpB without reverting or re-transferring
        assertEq(npm.ownerOf(_tokenIdOf(lpA)), lpA);
        assertEq(npm.ownerOf(_tokenIdOf(lpB)), lpB);
        assertEq(npm.ownerOf(_tokenIdOf(lpC)), lpC);
        (uint32 done,) = _unstakeProgress(id);
        assertEq(done, 3);
    }

    function test_ManualUnstake_AfterAutoReturn_Reverts() public {
        _settledEpoch3();
        arena.unstakeBatch(id, 10);
        vm.prank(lpA);
        vm.expectRevert(IFeeArena.NotOwner.selector); // unstaked tokens can't re-unstake
        arena.unstake(_tokenIdOf(lpA));
    }

    function test_Claim_AfterAutoReturn_StillPaysOwner() public {
        _settledEpoch3();
        arena.unstakeBatch(id, 10); // NFT already back in lpA's wallet
        arena.claim(id, _tokenIdOf(lpA)); // claim is custody-independent
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertGt(e.potUSDC, 0, "pot funded");
        assertEq(usdc.balanceOf(lpA), e.potUSDC, "sole UP winner takes the USDC pot");
        assertEq(weth.balanceOf(lpA), e.potWETH, "sole UP winner takes the WETH pot");
    }

    // ---- park-and-continue (the failure-isolation core) ----

    function test_UnstakeBatch_ParksRevertingReceiver_ReturnsRest() public {
        SwitchableReceiver rcv = new SwitchableReceiver(arena, npm); // accept == false
        uint256 rcvTokenId = _settledEpochWithReceiver(address(rcv));

        vm.expectEmit(true, true, true, true, address(arena));
        emit IFeeArena.AutoUnstakeFailed(id, address(rcv), rcvTokenId);
        arena.unstakeBatch(id, 10);

        // neighbors returned; hostile receiver parked (still escrowed, still pullable)
        assertEq(npm.ownerOf(_tokenIdOf(lpA)), lpA, "EOA before the bad receiver returned");
        assertEq(npm.ownerOf(_tokenIdOf(lpC)), lpC, "EOA after the bad receiver returned");
        assertEq(npm.ownerOf(rcvTokenId), address(arena), "parked token stays escrowed");
        assertFalse(arena.getStake(rcvTokenId).unstaked, "parked position stays pullable");

        // cursor passed the parked token: a later batch never retries it
        (uint32 done, uint32 total) = _unstakeProgress(id);
        assertEq(done, total);

        // fallback: the owner fixes its receiver and pulls manually
        rcv.setAccept(true);
        rcv.pull(rcvTokenId);
        assertEq(npm.ownerOf(rcvTokenId), address(rcv), "manual unstake fallback works");
    }

    function test_UnstakeBatch_ParksGasBurner_ReturnsRest() public {
        GasBurnReceiver rcv = new GasBurnReceiver(address(arena), npm);
        uint256 rcvTokenId = _settledEpochWithReceiver(address(rcv));

        arena.unstakeBatch{gas: 2_000_000}(id, 10); // sized so only the stipend can burn

        assertEq(npm.ownerOf(_tokenIdOf(lpA)), lpA, "gas burner could not OOG the batch");
        assertEq(npm.ownerOf(_tokenIdOf(lpC)), lpC);
        assertEq(npm.ownerOf(rcvTokenId), address(arena), "gas burner parked");
        assertFalse(arena.getStake(rcvTokenId).unstaked);
    }

    function test_UnstakeBatch_ReentrantReceiver_IsParked_OthersReturned() public {
        ReentrantReceiver rcv = new ReentrantReceiver(arena, npm);
        uint256 rcvTokenId = _settledEpochWithReceiver(address(rcv));
        rcv.setEpochId(id);

        arena.unstakeBatch(id, 10);

        assertEq(npm.ownerOf(_tokenIdOf(lpA)), lpA);
        assertEq(npm.ownerOf(_tokenIdOf(lpC)), lpC);
        assertEq(npm.ownerOf(rcvTokenId), address(arena), "reentrant receiver parked");
        assertFalse(arena.getStake(rcvTokenId).unstaked);
    }
}
