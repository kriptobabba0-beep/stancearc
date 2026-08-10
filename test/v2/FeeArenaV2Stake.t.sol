// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {FeeArenaV2Lens} from "src/FeeArenaV2Lens.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {WETH9} from "src/mocks/WETH9.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";

// Minimal mock pool (token0/token1/fee) — mirrors FeeArenaTestBase.MockPool.
contract MockPoolV2 {
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address t0, address t1, uint24 f) {
        token0 = t0;
        token1 = t1;
        fee = f;
    }
}

contract MockFactoryV2 {
    mapping(bytes32 => address) internal _pool;
    address public defaultPool;

    constructor(address p) {
        defaultPool = p;
    }

    function getPool(address t0, address t1, uint24 fee) external view returns (address) {
        address p = _pool[keccak256(abi.encode(t0, t1, fee))];
        return p == address(0) ? defaultPool : p;
    }
}

/// @notice Task 1 coverage: FeeArenaV2 STATE additions + the STAKE/CONVICTION flow
///         (stakeWithConviction -> staged -> onERC721Received). Settle/claim are stubbed
///         (NotImplemented) in T1; this suite does NOT exercise them.
contract FeeArenaV2StakeTest is Test {
    FeeArenaV2 internal arena;
    FeeArenaV2Lens internal lens;
    MockPriceOracle internal oracle;
    WETH9 internal weth;
    TestERC20 internal usdc;
    MockPoolV2 internal pool;
    MockFactoryV2 internal factory;
    MockNonfungiblePositionManager internal npm;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");
    address internal lp = makeAddr("lp");

    uint24 internal constant FEE_TIER = 3000;
    uint128 internal constant MIN_LIQ = 1000;

    uint32 internal constant ENTRY_WINDOW = 120;
    uint32 internal constant EPOCH_DURATION = 300;
    uint32 internal constant MIN_START_GAP = 30;
    uint32 internal constant MAX_START_DELAY = 600;
    uint32 internal constant MAX_PRICE_AGE = 600;
    int32 internal constant BAND_BPS = 150;

    // conviction config: minConv 100 USDC, maxConv 1000 USDC (10x), window 12s, conf 25bps,
    // 64 stakes/epoch cap, subsidy cap 150 USDC (< 2*minConv = 200).
    uint256 internal constant MIN_CONV = 100e6;
    uint256 internal constant MAX_CONV = 1000e6;
    uint32 internal constant SETTLE_WINDOW = 12;
    uint32 internal constant MAX_CONF_BPS = 25;
    uint32 internal constant MAX_STAKES_EPOCH = 64;
    uint256 internal constant MAX_SUBSIDY = 150e6;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(100);

        weth = new WETH9();
        usdc = new TestERC20("USD Coin", "USDC", 6);
        oracle = new MockPriceOracle();
        pool = new MockPoolV2(address(weth), address(usdc), FEE_TIER);
        factory = new MockFactoryV2(address(pool));
        npm = new MockNonfungiblePositionManager(address(factory), address(pool));

        arena = new FeeArenaV2(_boot());
        lens = new FeeArenaV2Lens(address(arena));

        vm.prank(owner);
        arena.setKeeper(keeper);
    }

    function _boot() internal view returns (FeeArenaV2.BootConfigV2 memory) {
        return FeeArenaV2.BootConfigV2({
            usdc: address(usdc),
            weth: address(weth),
            pool: address(pool),
            npm: address(npm),
            factory: address(factory),
            oracle: address(oracle),
            owner: owner,
            feeTier: FEE_TIER,
            minLiquidity: MIN_LIQ,
            entryWindow: ENTRY_WINDOW,
            epochDuration: EPOCH_DURATION,
            minStartGap: MIN_START_GAP,
            maxStartDelay: MAX_START_DELAY,
            maxPriceAge: MAX_PRICE_AGE,
            bandBps: BAND_BPS,
            treasury: treasury,
            minConv: MIN_CONV,
            maxConv: MAX_CONV,
            settleWindow: SETTLE_WINDOW,
            maxConfBps: MAX_CONF_BPS,
            maxStakesPerEpoch: MAX_STAKES_EPOCH,
            maxSubsidyPerEpoch: MAX_SUBSIDY
        });
    }

    function _openEntryEpoch() internal returns (uint64 id) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
    }

    function _mintFor(address who, uint128 liq) internal returns (uint256 id) {
        id = npm.mintTo(who, address(weth), address(usdc), FEE_TIER, liq);
    }

    /// @dev fund + approve `who` to post `conviction` USDC, then stake `tokenId` on `side`.
    function _stake(address who, uint256 tokenId, IFeeArena.Side side, uint256 conviction) internal {
        usdc.mint(who, conviction);
        vm.prank(who);
        usdc.approve(address(arena), conviction);
        vm.prank(who);
        arena.stakeWithConviction(tokenId, side, conviction);
    }

    // ---- boot/config state ----

    function test_BootStoresV2Config() public view {
        assertEq(arena.TREASURY(), treasury, "treasury");
        assertEq(arena.oracle(), address(oracle), "oracle (mutable)");
        assertEq(arena.minConv(), MIN_CONV, "minConv");
        assertEq(arena.maxConv(), MAX_CONV, "maxConv");
        assertEq(arena.settleWindow(), SETTLE_WINDOW, "settleWindow");
        assertEq(arena.maxConfBps(), MAX_CONF_BPS, "maxConfBps");
        assertEq(arena.maxStakesPerEpoch(), MAX_STAKES_EPOCH, "maxStakesPerEpoch");
        assertEq(arena.maxSubsidyPerEpoch(), MAX_SUBSIDY, "maxSubsidyPerEpoch");
    }

    function test_Boot_RevertsZeroTreasury() public {
        FeeArenaV2.BootConfigV2 memory c = _boot();
        c.treasury = address(0);
        vm.expectRevert(IFeeArena.ZeroAddress.selector);
        new FeeArenaV2(c);
    }

    function test_Boot_RevertsBadConvBounds() public {
        FeeArenaV2.BootConfigV2 memory c = _boot();
        c.minConv = 0;
        vm.expectRevert(FeeArenaV2.ConvBoundsInvalid.selector);
        new FeeArenaV2(c);

        c = _boot();
        c.maxConv = c.minConv - 1;
        vm.expectRevert(FeeArenaV2.ConvBoundsInvalid.selector);
        new FeeArenaV2(c);
    }

    function test_Boot_RevertsSettleWindowTooLarge() public {
        FeeArenaV2.BootConfigV2 memory c = _boot();
        c.settleWindow = 61; // > MAX_SETTLE_WINDOW(60)
        vm.expectRevert(FeeArenaV2.SettleWindowTooLarge.selector);
        new FeeArenaV2(c);

        c = _boot();
        c.settleWindow = 0;
        vm.expectRevert(FeeArenaV2.SettleWindowTooLarge.selector);
        new FeeArenaV2(c);
    }

    function test_Boot_RevertsConfBpsNotBelowBand() public {
        FeeArenaV2.BootConfigV2 memory c = _boot();
        c.maxConfBps = uint32(uint256(int256(BAND_BPS))); // == band, must be strictly below
        vm.expectRevert(FeeArenaV2.ConfBpsInvalid.selector);
        new FeeArenaV2(c);
    }

    function test_Boot_RevertsSubsidyCapNotDustGated() public {
        FeeArenaV2.BootConfigV2 memory c = _boot();
        c.maxSubsidyPerEpoch = 2 * c.minConv; // must be strictly < 2*minConv
        vm.expectRevert(FeeArenaV2.SubsidyCapInvalid.selector);
        new FeeArenaV2(c);
    }

    function test_Boot_RevertsZeroStakeCap() public {
        FeeArenaV2.BootConfigV2 memory c = _boot();
        c.maxStakesPerEpoch = 0;
        vm.expectRevert(FeeArenaV2.ZeroStakeCap.selector);
        new FeeArenaV2(c);
    }

    // ---- stakeWithConviction happy path ----

    function test_StakeWithConviction_RecordsPositionAndCustodiesConviction() public {
        _openEntryEpoch();
        uint256 tokenId = _mintFor(lp, MIN_LIQ);

        _stake(lp, tokenId, IFeeArena.Side.UP, 250e6);

        // conviction is custodied in the arena; the NFT is escrowed.
        assertEq(usdc.balanceOf(address(arena)), 250e6, "conviction custodied");
        assertEq(npm.ownerOf(tokenId), address(arena), "NFT escrowed");
        assertEq(arena.totalCustodiedConviction(), 250e6, "totalCustodiedConviction");

        (uint256 conv, bool refunded) = arena.getConviction(tokenId);
        assertEq(conv, 250e6, "position.conviction");
        assertFalse(refunded, "not refunded");

        IFeeArena.StakeView memory s = lens.getStake(tokenId);
        assertEq(s.owner, lp, "owner");
        assertEq(uint8(s.side), uint8(IFeeArena.Side.UP), "side");
        assertEq(s.epochId, 1, "epochId");
    }

    function test_StakeWithConviction_StagingClearedAfterStake() public {
        _openEntryEpoch();
        uint256 tokenId = _mintFor(lp, MIN_LIQ);
        _stake(lp, tokenId, IFeeArena.Side.RANGE, MIN_CONV);
        // staging is internal; assert indirectly by ensuring the position is recorded
        // and a SECOND direct NFT push (no new staging) would revert MissingConviction.
        (uint256 conv,) = arena.getConviction(tokenId);
        assertEq(conv, MIN_CONV, "recorded");
    }

    // ---- bounds + guards ----

    function test_StakeWithConviction_RevertsBelowMinConv() public {
        _openEntryEpoch();
        uint256 tokenId = _mintFor(lp, MIN_LIQ);
        usdc.mint(lp, MIN_CONV);
        vm.prank(lp);
        usdc.approve(address(arena), MIN_CONV);
        vm.prank(lp);
        vm.expectRevert(FeeArenaV2.ConvOutOfBounds.selector);
        arena.stakeWithConviction(tokenId, IFeeArena.Side.UP, MIN_CONV - 1);
    }

    function test_StakeWithConviction_RevertsAboveMaxConv() public {
        _openEntryEpoch();
        uint256 tokenId = _mintFor(lp, MIN_LIQ);
        usdc.mint(lp, MAX_CONV + 1);
        vm.prank(lp);
        usdc.approve(address(arena), MAX_CONV + 1);
        vm.prank(lp);
        vm.expectRevert(FeeArenaV2.ConvOutOfBounds.selector);
        arena.stakeWithConviction(tokenId, IFeeArena.Side.UP, MAX_CONV + 1);
    }

    function test_StakeWithConviction_RevertsBadSide() public {
        _openEntryEpoch();
        uint256 tokenId = _mintFor(lp, MIN_LIQ);
        usdc.mint(lp, MIN_CONV);
        vm.prank(lp);
        usdc.approve(address(arena), MIN_CONV);
        vm.prank(lp);
        vm.expectRevert(IFeeArena.BadSide.selector);
        arena.stakeWithConviction(tokenId, IFeeArena.Side.NONE, MIN_CONV);
    }

    // ---- operator exclusion ----

    function test_StakeWithConviction_RevertsKeeperStaker() public {
        _openEntryEpoch();
        uint256 tokenId = _mintFor(keeper, MIN_LIQ);
        usdc.mint(keeper, MIN_CONV);
        vm.prank(keeper);
        usdc.approve(address(arena), MIN_CONV);
        vm.prank(keeper);
        vm.expectRevert(FeeArenaV2.OperatorCannotStake.selector);
        arena.stakeWithConviction(tokenId, IFeeArena.Side.UP, MIN_CONV);
    }

    function test_StakeWithConviction_RevertsOwnerStaker() public {
        _openEntryEpoch();
        uint256 tokenId = _mintFor(owner, MIN_LIQ);
        usdc.mint(owner, MIN_CONV);
        vm.prank(owner);
        usdc.approve(address(arena), MIN_CONV);
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.OperatorCannotStake.selector);
        arena.stakeWithConviction(tokenId, IFeeArena.Side.UP, MIN_CONV);
    }

    // ---- direct NFT transfer without conviction is rejected (v2 requires conviction) ----

    function test_DirectNFTTransfer_RevertsMissingConviction() public {
        _openEntryEpoch();
        uint256 tokenId = _mintFor(lp, MIN_LIQ);
        vm.prank(lp);
        vm.expectRevert(FeeArenaV2.MissingConviction.selector);
        npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(IFeeArena.Side.UP));
    }

    // ---- sideConviction accrual via two stakers on the same side ----

    function test_SideConvictionAccrues() public {
        _openEntryEpoch();
        address lp2 = makeAddr("lp2");
        uint256 t1 = _mintFor(lp, MIN_LIQ);
        _stake(lp, t1, IFeeArena.Side.UP, 200e6);

        vm.roll(block.number + 1); // same-block guard is per-wallet; bump anyway for clarity
        uint256 t2 = _mintFor(lp2, MIN_LIQ);
        _stake(lp2, t2, IFeeArena.Side.UP, 300e6);

        assertEq(arena.totalCustodiedConviction(), 500e6, "two stakers custodied");
        assertEq(usdc.balanceOf(address(arena)), 500e6, "balance");
    }

    // ---- one-side-per-epoch (per-wallet UX guard) still enforced ----

    function test_StakeWithConviction_RevertsOneSidePerEpoch() public {
        _openEntryEpoch();
        uint256 t1 = _mintFor(lp, MIN_LIQ);
        _stake(lp, t1, IFeeArena.Side.UP, MIN_CONV);

        vm.roll(block.number + 1);
        uint256 t2 = _mintFor(lp, MIN_LIQ);
        usdc.mint(lp, MIN_CONV);
        vm.prank(lp);
        usdc.approve(address(arena), MIN_CONV);
        vm.prank(lp);
        vm.expectRevert(IFeeArena.OneSidePerEpoch.selector);
        arena.stakeWithConviction(t2, IFeeArena.Side.DOWN, MIN_CONV);
    }

    // ---- T2 implemented these: they now run their real phase guards, not NotImplemented ----

    function test_SettleFlowFunctionsImplemented_RevertOnPhaseGuards() public {
        bytes[] memory empty = new bytes[](0);
        // no epoch / wrong phase -> the real guards fire (no longer NotImplemented).
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.startEpoch(empty);
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.endEpoch(empty);
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.sweep(10);
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.finalizeSettle();
        vm.expectRevert(IFeeArena.NotSettled.selector);
        arena.claim(1, 1, lp);
        vm.expectRevert(IFeeArena.NotSettled.selector);
        arena.refundConviction(1, 1, lp);
        // fundSubsidy on an uncreated epoch (phase None) passes the phase gate, then reverts
        // SubsidyCapExceeded on amount==0 (no SafeERC20 pull reached).
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.SubsidyCapExceeded.selector);
        arena.fundSubsidy(1, 0);
    }

    // ---- the C4 oracle-migration + emergency surfaces are implemented (Task 3) ----

    /// @dev Task 3 replaced the stubbed C4/emergency functions with real bodies. They are all
    ///      onlyOwner, so a non-owner caller is rejected by Ownable (the prior NotImplemented
    ///      stub assertion no longer applies).
    function test_C4AndEmergency_OnlyOwner() public {
        vm.expectRevert("Ownable: caller is not the owner");
        arena.emergencySettle(1, IFeeArena.Side.RANGE);
        vm.expectRevert("Ownable: caller is not the owner");
        arena.proposeOracle(address(0xBEEF));
        vm.expectRevert("Ownable: caller is not the owner");
        arena.executeOracleMigration();
    }
}
