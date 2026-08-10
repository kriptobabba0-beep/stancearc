// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {MaliciousReceiver} from "src/mocks/MaliciousReceiver.sol";

contract StakeGuardsTest is Test {
    MockNonfungiblePositionManager internal npm;

    function setUp() public {
        npm = new MockNonfungiblePositionManager(address(0xFAC), address(0xF0F1));
    }

    function test_Mock_FactoryGetter() public view {
        assertEq(npm.factory(), address(0xFAC));
    }

    function test_Mock_MintRecordsPositionAndOwner() public {
        address lp = makeAddr("lp");
        uint256 id = npm.mintTo(lp, address(0xAAA0), address(0xBBB1), 3000, 5_000_000);
        assertEq(npm.ownerOf(id), lp);
        (,, address t0, address t1, uint24 fee,,, uint128 liq,,,,) = npm.positions(id);
        assertEq(t0, address(0xAAA0));
        assertEq(t1, address(0xBBB1));
        assertEq(uint256(fee), 3000);
        assertEq(uint256(liq), 5_000_000);
    }
}

contract StakeStorageTest is FeeArenaTestBase {
    function test_GetStake_DefaultIsEmpty() public view {
        IFeeArena.StakeView memory s = arena.getStake(999);
        assertEq(s.owner, address(0));
        assertEq(uint256(s.epochId), 0);
        assertEq(uint8(s.side), uint8(IFeeArena.Side.NONE));
        assertEq(s.contribution6, 0);
        assertEq(s.tokenId, 999);
    }

    /// @dev Guards the vm.store-based settle helpers in the base fixture: if the L1
    ///      storage layout shifts, these slot constants break loudly here instead of
    ///      silently corrupting unstake test setup.
    function test_StorageSlots_AreCorrect() public {
        address lp = makeAddr("lp");
        uint64 id = _openEntryEpoch();
        uint256 tokenId = _mintPosition(lp, MIN_LIQUIDITY);
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(IFeeArena.Side.UP));

        // POSITIONS_SLOT/EPOCHS_SLOT: forcing swept/settled must be observable via views.
        assertEq(arena.getStake(tokenId).swept, false);
        _forceSwept(tokenId);
        assertEq(arena.getStake(tokenId).swept, true);

        assertTrue(arena.getEpoch(id).phase != IFeeArena.PhaseView.Settled);
        _forceSettled(id);
        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArena.PhaseView.Settled));
    }
}

contract StakeHappyPathTest is FeeArenaTestBase {
    event Staked(
        uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, IFeeArena.Side side, uint32 stakedCount
    );

    function setUp() public override {
        super.setUp();
        _openEntryEpoch(); // epoch #1 in EntryOpen
    }

    function _encodeSide(IFeeArena.Side side) internal pure returns (bytes memory) {
        return abi.encode(side);
    }

    function test_Stake_RecordsPositionAndCounters() public {
        address lp = makeAddr("lp");
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);

        vm.expectEmit(true, true, true, true, address(arena));
        emit Staked(1, lp, id, IFeeArena.Side.UP, 1);

        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), id, _encodeSide(IFeeArena.Side.UP));

        // NFT escrowed in the arena
        assertEq(npm.ownerOf(id), address(arena));

        IFeeArena.StakeView memory s = arena.getStake(id);
        assertEq(s.owner, lp);
        assertEq(uint256(s.epochId), 1);
        assertEq(uint8(s.side), uint8(IFeeArena.Side.UP));
        assertEq(s.swept, false);
        assertEq(s.claimed, false);
        assertEq(s.unstaked, false);

        // epoch.stakedCount incremented
        IFeeArena.EpochView memory e = arena.getEpoch(1);
        assertEq(uint256(e.stakedCount), 1);

        // lastStakeBlock recorded
        assertEq(arena.lastStakeBlock(lp), block.number);

        // user per-epoch list updated (Group M's getUserStakes view is not built yet,
        // so read the canonical public userEpochTokenIds mapping directly).
        assertEq(arena.userEpochTokenIds(lp, 1, 0), id);
    }
}

contract StakeGuardMatrixTest is FeeArenaTestBase {
    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        _openEntryEpoch();
    }

    function _stake(address from, uint256 id, IFeeArena.Side side) internal {
        vm.prank(from);
        npm.safeTransferFrom(from, address(arena), id, abi.encode(side));
    }

    function test_Revert_NonNPMSender() public {
        // call onERC721Received directly from a non-NPM address
        vm.expectRevert(IFeeArena.NotNPM.selector);
        vm.prank(makeAddr("randomEOA"));
        arena.onERC721Received(address(this), lp, 1, abi.encode(IFeeArena.Side.UP));
    }

    function test_Revert_NoneSide() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        vm.expectRevert(IFeeArena.BadSide.selector);
        _stake(lp, id, IFeeArena.Side.NONE);
    }

    function test_Revert_BadSidePayloadLength() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        vm.expectRevert(IFeeArena.BadSideData.selector);
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), id, hex"1234"); // length != 32
    }

    function test_Revert_SideAbove3() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        // encode a uint8 = 4 (out of [UP,RANGE]) as 32 bytes
        vm.expectRevert(IFeeArena.BadSide.selector);
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), id, abi.encode(uint8(4)));
    }
}

contract StakeWindowGuardTest is FeeArenaTestBase {
    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        _openEntryEpoch();
    }

    function _stake(uint256 id, IFeeArena.Side side) internal {
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), id, abi.encode(side));
    }

    function test_Revert_NotEntryWindow_WhenRunning() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        // advance to Running: warp past entryClose+gap, set start price, crank startEpoch
        IFeeArena.EpochView memory e = arena.getEpoch(1);
        vm.warp(e.entryCloseTime + MIN_START_GAP);
        _setOraclePrice(3000e18);
        arena.startEpoch(new bytes[](0));
        // now phase==Running, staking must revert
        vm.expectRevert(IFeeArena.NotEntryWindow.selector);
        _stake(id, IFeeArena.Side.UP);
    }

    function test_Revert_NotEntryWindow_AtEntryClose() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        IFeeArena.EpochView memory e = arena.getEpoch(1);
        // exactly at entryCloseTime: strict `<` boundary -> rejected
        vm.warp(e.entryCloseTime);
        vm.expectRevert(IFeeArena.NotEntryWindow.selector);
        _stake(id, IFeeArena.Side.UP);
    }

    function test_Revert_SameBlock_SecondStakeSameBlock() public {
        uint256 id1 = _mintPosition(lp, MIN_LIQUIDITY);
        uint256 id2 = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(id1, IFeeArena.Side.UP); // sets lastStakeBlock[lp] = block.number
        // same block, second stake -> SameBlock
        vm.expectRevert(IFeeArena.SameBlock.selector);
        _stake(id2, IFeeArena.Side.UP);
    }

    function test_OK_SecondStakeNextBlock() public {
        uint256 id1 = _mintPosition(lp, MIN_LIQUIDITY);
        uint256 id2 = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(id1, IFeeArena.Side.UP);
        vm.roll(block.number + 1); // monotonic block.number guard, not timestamp
        _stake(id2, IFeeArena.Side.UP); // same side -> OK
        IFeeArena.EpochView memory e = arena.getEpoch(1);
        assertEq(uint256(e.stakedCount), 2);
    }
}

contract StakeOneSideAndCapsTest is FeeArenaTestBase {
    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        _openEntryEpoch();
    }

    function _stake(address from, uint256 id, IFeeArena.Side side) internal {
        vm.prank(from);
        npm.safeTransferFrom(from, address(arena), id, abi.encode(side));
    }

    function test_Revert_OneSidePerEpoch_DifferentSide() public {
        uint256 id1 = _mintPosition(lp, MIN_LIQUIDITY);
        uint256 id2 = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(lp, id1, IFeeArena.Side.UP);
        vm.roll(block.number + 1); // pass same-block guard
        vm.expectRevert(IFeeArena.OneSidePerEpoch.selector);
        _stake(lp, id2, IFeeArena.Side.DOWN);
    }

    function test_OK_SameSideTwice() public {
        uint256 id1 = _mintPosition(lp, MIN_LIQUIDITY);
        uint256 id2 = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(lp, id1, IFeeArena.Side.UP);
        vm.roll(block.number + 1);
        _stake(lp, id2, IFeeArena.Side.UP);
        assertEq(uint256(arena.getEpoch(1).stakedCount), 2);
    }

    function test_Revert_CapExceeded_PerEpoch() public {
        vm.prank(owner);
        arena.setStakeCaps(1, 100); // 1 stake per epoch max
        address lp2 = makeAddr("lp2");
        uint256 idA = _mintPosition(lp, MIN_LIQUIDITY);
        uint256 idB = _mintPosition(lp2, MIN_LIQUIDITY);
        _stake(lp, idA, IFeeArena.Side.UP);
        vm.roll(block.number + 1);
        vm.expectRevert(IFeeArena.CapExceeded.selector);
        _stake(lp2, idB, IFeeArena.Side.UP);
    }

    function test_Revert_CapExceeded_PerUser() public {
        vm.prank(owner);
        arena.setStakeCaps(100, 1); // 1 stake per user max
        uint256 id1 = _mintPosition(lp, MIN_LIQUIDITY);
        uint256 id2 = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(lp, id1, IFeeArena.Side.UP);
        vm.roll(block.number + 1);
        vm.expectRevert(IFeeArena.CapExceeded.selector);
        _stake(lp, id2, IFeeArena.Side.UP);
    }
}

contract StakePoolValidationTest is FeeArenaTestBase {
    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        _openEntryEpoch();
    }

    function _stakeId(uint256 id) internal {
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), id, abi.encode(IFeeArena.Side.UP));
    }

    function test_Revert_WrongPool() public {
        // position on a token pair the factory maps to a DIFFERENT pool
        address otherPool = makeAddr("otherPool");
        address tA = makeAddr("tokenA");
        address tB = makeAddr("tokenB");
        factory.setPool(tA, tB, FEE_TIER, otherPool);
        uint256 id = npm.mintTo(lp, tA, tB, FEE_TIER, MIN_LIQUIDITY);
        vm.expectRevert(IFeeArena.NotPool.selector);
        _stakeId(id);
    }

    function test_Revert_WrongFeeTier() public {
        // correct tokens, wrong fee tier -> factory.getPool(...,fee) != POOL
        uint24 wrongFee = 500;
        factory.setPool(address(weth), address(usdc), wrongFee, address(0)); // no pool at this fee
        uint256 id = npm.mintTo(lp, address(weth), address(usdc), wrongFee, MIN_LIQUIDITY);
        vm.expectRevert(IFeeArena.NotPool.selector);
        _stakeId(id);
    }

    function test_Revert_BelowMinLiquidity() public {
        uint256 id = npm.mintTo(lp, address(weth), address(usdc), FEE_TIER, MIN_LIQUIDITY - 1);
        vm.expectRevert(IFeeArena.InsufficientLiquidity.selector);
        _stakeId(id);
    }

    function test_OK_ValidPoolFeeAndLiquidity() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY); // weth/usdc, FEE_TIER, >= MIN_LIQUIDITY
        _stakeId(id);
        assertEq(npm.ownerOf(id), address(arena));
    }
}

contract StakeAtomicityAndWrapperTest is FeeArenaTestBase {
    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        _openEntryEpoch();
    }

    function test_Atomic_RevertLeavesNoState() public {
        // below-min-liquidity stake reverts -> NFT stays with LP, no counters move
        uint256 id = npm.mintTo(lp, address(weth), address(usdc), FEE_TIER, MIN_LIQUIDITY - 1);
        vm.prank(lp);
        vm.expectRevert(IFeeArena.InsufficientLiquidity.selector);
        npm.safeTransferFrom(lp, address(arena), id, abi.encode(IFeeArena.Side.UP));

        assertEq(npm.ownerOf(id), lp); // NFT NOT escrowed
        assertEq(uint256(arena.getEpoch(1).stakedCount), 0); // counter unchanged
        assertEq(arena.getStake(id).owner, address(0)); // no Position recorded
    }

    function test_Revert_StakeWhenPaused() public {
        vm.prank(owner);
        arena.pause();
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        vm.prank(lp);
        vm.expectRevert(); // Pausable: paused (OZ revert)
        npm.safeTransferFrom(lp, address(arena), id, abi.encode(IFeeArena.Side.UP));
    }

    function test_StakeWithSide_Wrapper() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        vm.prank(lp);
        arena.stakeWithSide(id, IFeeArena.Side.UP);
        assertEq(npm.ownerOf(id), address(arena));
        assertEq(uint8(arena.getStake(id).side), uint8(IFeeArena.Side.UP));
    }
}

contract UnstakeTest is FeeArenaTestBase {
    event Unstaked(uint64 indexed epochId, address indexed owner, uint256 indexed tokenId);

    address internal lp = makeAddr("lp");

    function setUp() public override {
        super.setUp();
        _openEntryEpoch();
    }

    function _stake(uint256 id, IFeeArena.Side side) internal {
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), id, abi.encode(side));
    }

    function test_Revert_Unstake_BeforeSettled() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(id, IFeeArena.Side.UP);
        vm.expectRevert(IFeeArena.NotSettled.selector);
        vm.prank(lp);
        arena.unstake(id);
    }

    function test_Revert_Unstake_NotOwner() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(id, IFeeArena.Side.UP);
        _settleEpochTo(3000e18, id);
        vm.expectRevert(IFeeArena.NotOwner.selector);
        vm.prank(makeAddr("notLp"));
        arena.unstake(id);
    }

    function test_Unstake_ReturnsNFT_AfterSettled() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(id, IFeeArena.Side.UP);
        _settleEpochTo(3000e18, id);

        vm.expectEmit(true, true, true, false, address(arena));
        emit Unstaked(1, lp, id);

        vm.prank(lp);
        arena.unstake(id);

        assertEq(npm.ownerOf(id), lp); // NFT returned
        assertEq(arena.getStake(id).unstaked, true);
    }

    function test_Revert_Unstake_Twice() public {
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(id, IFeeArena.Side.UP);
        _settleEpochTo(3000e18, id);
        vm.prank(lp);
        arena.unstake(id);
        // NFT no longer escrowed -> second unstake reverts (already unstaked)
        vm.expectRevert(IFeeArena.NotOwner.selector);
        vm.prank(lp);
        arena.unstake(id);
    }

    function test_Revert_Unstake_NotSwept() public {
        // settled epoch but this position was never swept -> NotSwept
        uint256 id = _mintPosition(lp, MIN_LIQUIDITY);
        _stake(id, IFeeArena.Side.UP);
        // settle WITHOUT marking the position swept
        uint256[] memory none = new uint256[](0);
        _settleEpochTo(3000e18, none);
        vm.expectRevert(IFeeArena.NotSwept.selector);
        vm.prank(lp);
        arena.unstake(id);
    }
}

contract UnstakeReentrancyTest is FeeArenaTestBase {
    MaliciousReceiver internal evil;

    function setUp() public override {
        super.setUp();
        _openEntryEpoch();
        evil = new MaliciousReceiver();
    }

    function test_Reentrancy_OnUnstake_IsBlocked() public {
        // mint to the malicious contract and stake from it
        uint256 id = npm.mintTo(address(evil), address(weth), address(usdc), FEE_TIER, MIN_LIQUIDITY);
        // evil must initiate the stake transfer (it owns the NFT)
        vm.prank(address(evil));
        npm.safeTransferFrom(address(evil), address(arena), id, abi.encode(IFeeArena.Side.UP));

        _settleEpochTo(3000e18, id);

        // arm re-entry: on receiving the NFT back, evil will call unstake(id) again
        evil.arm(address(arena), id);

        // the outer unstake triggers the callback -> inner unstake reverts (ReentrancyGuard)
        // -> mock NPM sees a non-selector return / revert -> whole tx reverts.
        vm.prank(address(evil));
        vm.expectRevert(); // ReentrancyGuard: reentrant call (bubbled through the transfer)
        arena.unstake(id);

        // state untouched: NFT still escrowed, not marked unstaked
        assertEq(npm.ownerOf(id), address(arena));
        assertEq(arena.getStake(id).unstaked, false);
    }
}
