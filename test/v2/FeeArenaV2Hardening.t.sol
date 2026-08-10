// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {EpochV2, Position} from "src/FeeArenaV2Types.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {PythPriceOracleV2} from "src/oracles/PythPriceOracleV2.sol";
import {IPinnedPriceOracle} from "src/interfaces/IPinnedPriceOracle.sol";
import {WETH9} from "src/mocks/WETH9.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

contract MockPoolV2H {
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address t0, address t1, uint24 f) {
        token0 = t0;
        token1 = t1;
        fee = f;
    }
}

contract MockFactoryV2H {
    address public defaultPool;

    constructor(address p) {
        defaultPool = p;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return defaultPool;
    }
}

/// @dev An "oracle" that does NOT implement IPriceOracle.getPrice (sanity probe must reject it).
contract BadOracle {
    fallback() external {}
}

/// @notice Task 3 coverage: HARDENING — pinned settle endpoints (T1), Pyth confidence bound (T2),
///         O(1) solvency (C2), timelocked oracle migration (C4) + emergencySettle conviction refund.
contract FeeArenaV2HardeningTest is Test {
    FeeArenaV2 internal arena;
    MockPriceOracle internal oracle;
    WETH9 internal weth;
    TestERC20 internal usdc;
    MockPoolV2H internal pool;
    MockFactoryV2H internal factory;
    MockNonfungiblePositionManager internal npm;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");

    uint24 internal constant FEE_TIER = 3000;
    uint128 internal constant MIN_LIQ = 1000;

    uint32 internal constant ENTRY_WINDOW = 120;
    uint32 internal constant EPOCH_DURATION = 300;
    uint32 internal constant MIN_START_GAP = 30;
    uint32 internal constant MAX_START_DELAY = 600;
    uint32 internal constant MAX_PRICE_AGE = 600;
    int32 internal constant BAND_BPS = 150;

    uint256 internal constant MIN_CONV = 100e6;
    uint256 internal constant MAX_CONV = 1000e6;
    uint32 internal constant SETTLE_WINDOW = 12;
    uint32 internal constant MAX_CONF_BPS = 25;
    uint32 internal constant MAX_STAKES_EPOCH = 64;
    uint256 internal constant MAX_SUBSIDY = 150e6;

    uint256 internal constant START_PRICE = 3000e18;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(100);
        weth = new WETH9();
        usdc = new TestERC20("USD Coin", "USDC", 6);
        oracle = new MockPriceOracle();
        pool = new MockPoolV2H(address(weth), address(usdc), FEE_TIER);
        factory = new MockFactoryV2H(address(pool));
        npm = new MockNonfungiblePositionManager(address(factory), address(pool));
        arena = new FeeArenaV2(_boot());
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

    // ---- helpers ----

    function _openEntryEpoch() internal returns (uint64 id) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
    }

    function _mintFor(address who, uint128 liq) internal returns (uint256 id) {
        id = npm.mintTo(who, address(weth), address(usdc), FEE_TIER, liq);
    }

    function _stake(address who, IFeeArena.Side side, uint256 conviction) internal returns (uint256 tokenId) {
        tokenId = _mintFor(who, MIN_LIQ);
        vm.roll(block.number + 1);
        usdc.mint(who, conviction);
        vm.prank(who);
        usdc.approve(address(arena), conviction);
        vm.prank(who);
        arena.stakeWithConviction(tokenId, side, conviction);
    }

    function _programOwed(uint256 tokenId, uint256 owedWeth, uint256 owedUsdc) internal {
        if (arena.wethIsToken0() == 1) {
            npm.setOwed(tokenId, uint128(owedWeth), uint128(owedUsdc));
        } else {
            npm.setOwed(tokenId, uint128(owedUsdc), uint128(owedWeth));
        }
        if (owedWeth > 0) {
            vm.deal(address(this), address(this).balance + owedWeth);
            weth.deposit{value: owedWeth}();
            weth.transfer(address(arena), owedWeth);
        }
        if (owedUsdc > 0) usdc.mint(address(arena), owedUsdc);
    }

    // ======================= T1: pinned settle endpoints =======================

    function test_T1_StartEpoch_RevertsWhenPriceOutsideStartWindow() public {
        uint64 id = _openEntryEpoch();
        EpochV2 memory e = arena.getEpoch(id);
        // Stamp a price just AFTER the start window upper bound (startTime + settleWindow + 1).
        vm.warp(uint256(e.startTime) + SETTLE_WINDOW + 1);
        oracle.setPrice(START_PRICE);
        // Crank from within maxStartDelay; the publishTime is past the pin window -> revert.
        vm.expectRevert(MockPriceOracle.OutOfWindow.selector);
        arena.startEpoch(new bytes[](0));
    }

    function test_T1_StartEpoch_PassesInsideStartWindow() public {
        uint64 id = _openEntryEpoch();
        EpochV2 memory e = arena.getEpoch(id);
        // Stamp a price INSIDE the window (startTime + a few seconds).
        vm.warp(uint256(e.startTime) + 5);
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));
        e = arena.getEpoch(id);
        assertEq(e.startPrice18, START_PRICE, "start price pinned");
        assertEq(uint8(e.phase), uint8(IFeeArena.Phase.Running), "Running");
    }

    function test_T1_EndEpoch_RevertsWhenPriceOutsideEndWindow() public {
        uint64 id = _openEntryEpoch();
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));

        e = arena.getEpoch(id);
        // Stamp the settle price PAST the end window (endTime + settleWindow + 1).
        vm.warp(uint256(e.endTime) + SETTLE_WINDOW + 1);
        oracle.setPrice(3300e18);
        vm.expectRevert(MockPriceOracle.OutOfWindow.selector);
        arena.endEpoch(new bytes[](0));
    }

    function test_T1_EndEpoch_RevertsWhenPriceStampedBeforeEndTime() public {
        uint64 id = _openEntryEpoch();
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));

        e = arena.getEpoch(id);
        // Stamp a settle price BEFORE endTime (lower bound of the pin window).
        vm.warp(uint256(e.endTime) - 1);
        oracle.setPrice(3300e18);
        vm.warp(uint256(e.endTime)); // crank is eligible, but the print is stale (pre-window)
        vm.expectRevert(MockPriceOracle.OutOfWindow.selector);
        arena.endEpoch(new bytes[](0));
    }

    function test_T1_SettleWindowHardCappedAt60s() public {
        assertEq(arena.MAX_SETTLE_WINDOW(), 60, "hard cap 60s");
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.SettleWindowTooLarge.selector);
        arena.setSettleWindow(61);
        // 60 is accepted (the boundary), 12 is the default.
        vm.prank(owner);
        arena.setSettleWindow(60);
        assertEq(arena.settleWindow(), 60, "60s accepted");
    }

    // ======================= T2: confidence bound =======================

    function test_T2_EndEpoch_RevertsWideConfidence() public {
        uint64 id = _openEntryEpoch();
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));

        e = arena.getEpoch(id);
        vm.warp(uint256(e.endTime));
        oracle.setPrice(3300e18);
        // conf bound: conf*BPS <= price*maxConfBps => conf <= 3300e18 * 25 / 10000 = 8.25e18.
        // Set conf JUST above the bound.
        oracle.setConf(8.26e18);
        vm.expectRevert(FeeArenaV2.WideConfidence.selector);
        arena.endEpoch(new bytes[](0));
    }

    function test_T2_EndEpoch_PassesAtConfBoundary() public {
        uint64 id = _openEntryEpoch();
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));

        e = arena.getEpoch(id);
        vm.warp(uint256(e.endTime));
        oracle.setPrice(3300e18);
        // conf exactly at the bound: 3300e18 * 25 / 10000 = 8.25e18.
        oracle.setConf(8.25e18);
        arena.endEpoch(new bytes[](0));
        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArena.Phase.Resolved), "Resolved at conf boundary");
    }

    function test_T2_StartEpoch_RevertsWideConfidence() public {
        uint64 id = _openEntryEpoch();
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        oracle.setConf(8e18); // 3000e18*25/10000 = 7.5e18; 8e18 > bound
        vm.expectRevert(FeeArenaV2.WideConfidence.selector);
        arena.startEpoch(new bytes[](0));
    }

    // ======================= T1/T2: PythPriceOracleV2 unit (parsePriceFeedUpdates) =======================

    function test_PythOracleV2_GetPinnedPrice_WindowAndConf() public {
        bytes32 feedId = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
        MockPyth pyth = new MockPyth(60, 1);
        PythPriceOracleV2 o = new PythPriceOracleV2(address(pyth), feedId);

        uint64 ts = uint64(block.timestamp);
        bytes[] memory data = new bytes[](1);
        // price $3000.00000000 (expo -8), conf $1.50000000 -> conf18 = 1.5e18.
        data[0] = pyth.createPriceFeedUpdateData(feedId, 300000000000, 150000000, -8, 300000000000, 0, ts);
        uint256 fee = pyth.getUpdateFee(data);

        // In-window [ts, ts+12]: returns the pinned price + 18-dp conf.
        (uint256 price18, uint256 conf18, uint64 publishTime) = o.getPinnedPrice{value: fee}(data, ts, ts + 12);
        assertEq(price18, 3000e18, "pinned price 18dp");
        assertEq(conf18, 1.5e18, "conf normalized to 18dp");
        assertEq(publishTime, ts, "publishTime echoed");

        // Out-of-window: parsePriceFeedUpdates reverts (PriceFeedNotFoundWithinRange).
        vm.expectRevert();
        o.getPinnedPrice{value: fee}(data, ts + 13, ts + 25);
    }

    function test_PythOracleV2_GetPinnedPrice_RevertsFeeTooLow() public {
        bytes32 feedId = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
        MockPyth pyth = new MockPyth(60, 1);
        PythPriceOracleV2 o = new PythPriceOracleV2(address(pyth), feedId);
        uint64 ts = uint64(block.timestamp);
        bytes[] memory data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(feedId, 300000000000, 0, -8, 300000000000, 0, ts);
        vm.expectRevert(PythPriceOracleV2.FeeTooLow.selector);
        o.getPinnedPrice{value: 0}(data, ts, ts + 12);
    }

    // ======================= C2: O(1) solvency, no settledEpochIds loop =======================

    /// @dev Drive several epochs all the way to Settled; the O(1) counter-based _assertSolvent
    ///      must keep claims working with NO unbounded settled-epoch loop (C2). Asserts the
    ///      counters net to zero once everything is paid out across many settled epochs.
    function test_C2_ManySettledEpochs_OneClaimStillWorks() public {
        uint256 N = 6;
        uint256[] memory tokens = new uint256[](N);
        address[] memory ups = new address[](N);

        for (uint256 k = 0; k < N; ++k) {
            uint64 id = _openEntryEpoch();
            address up = makeAddr(string(abi.encodePacked("up", k)));
            ups[k] = up;
            tokens[k] = _stake(up, IFeeArena.Side.UP, 400e6);
            _programOwed(tokens[k], 0, 1000e6);

            EpochV2 memory e = arena.getEpoch(id);
            vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
            oracle.setPrice(START_PRICE);
            arena.startEpoch(new bytes[](0));
            e = arena.getEpoch(id);
            vm.warp(uint256(e.endTime));
            oracle.setPrice(3300e18); // UP wins
            arena.endEpoch(new bytes[](0));
            arena.sweep(10);
            arena.finalizeSettle();
        }

        // Claim + refund every settled epoch; counters must drain to zero (O(1), no loop bloat).
        for (uint256 k = 0; k < N; ++k) {
            arena.claim(uint64(k + 1), tokens[k], ups[k]);
            arena.refundConviction(uint64(k + 1), tokens[k], ups[k]);
        }
        assertEq(arena.totalOwedUSDC(), 0, "all USDC drained");
        assertEq(arena.totalOwedWETH(), 0, "all WETH drained");
        assertEq(arena.totalCustodiedConviction(), 0, "no live conviction left");
    }

    // ======================= C4: timelocked oracle migration =======================

    function test_C4_ProposeOracle_RejectsBadCandidate() public {
        BadOracle bad = new BadOracle();
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.OracleSanityFailed.selector);
        arena.proposeOracle(address(bad));
    }

    function test_C4_ProposeOracle_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(IFeeArena.ZeroAddress.selector);
        arena.proposeOracle(address(0));
    }

    function test_C4_Execute_RevertsBeforeTimelock() public {
        MockPriceOracle next = new MockPriceOracle();
        vm.prank(owner);
        arena.proposeOracle(address(next));
        assertEq(arena.pendingOracle(), address(next), "pending set");

        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.TimelockNotElapsed.selector);
        arena.executeOracleMigration();
    }

    function test_C4_Execute_RevertsNoPending() public {
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.NoPendingOracle.selector);
        arena.executeOracleMigration();
    }

    function test_C4_Execute_SucceedsAfterTimelock_NoInFlightEpoch() public {
        MockPriceOracle next = new MockPriceOracle();
        vm.prank(owner);
        arena.proposeOracle(address(next));
        // warp past the 48h timelock; no epoch exists (phase None) -> migration allowed.
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        arena.executeOracleMigration();
        assertEq(arena.oracle(), address(next), "oracle swapped");
        assertEq(arena.pendingOracle(), address(0), "pending cleared");
        assertEq(arena.oracleUnlockTime(), 0, "unlock cleared");
    }

    function test_C4_Execute_RevertsWhenEpochInFlight() public {
        // Bring an epoch to Running (in-flight).
        uint64 id = _openEntryEpoch();
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0)); // Running

        MockPriceOracle next = new MockPriceOracle();
        vm.prank(owner);
        arena.proposeOracle(address(next));
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.EpochInFlight.selector);
        arena.executeOracleMigration();
    }

    function test_C4_Execute_AllowedWhenSettled() public {
        // Run an epoch to Settled, then migrate (Settled is a safe phase).
        uint64 id = _openEntryEpoch();
        _stake(makeAddr("u"), IFeeArena.Side.UP, 400e6);
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));
        e = arena.getEpoch(id);
        vm.warp(uint256(e.endTime));
        oracle.setPrice(3300e18);
        arena.endEpoch(new bytes[](0));
        arena.sweep(10);
        arena.finalizeSettle();

        MockPriceOracle next = new MockPriceOracle();
        vm.prank(owner);
        arena.proposeOracle(address(next));
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        arena.executeOracleMigration();
        assertEq(arena.oracle(), address(next), "migrated while Settled");
    }

    // ======================= emergencySettle: conviction refund both sides =======================

    function test_Emergency_RefundsConvictionBothSides_RollsPotForward() public {
        uint64 id = _openEntryEpoch();
        address up = makeAddr("up");
        address down = makeAddr("down");
        uint256 tUp = _stake(up, IFeeArena.Side.UP, 400e6);
        uint256 tDown = _stake(down, IFeeArena.Side.DOWN, 300e6);

        // Bring to Running, but NEVER end (oracle wedged): settlePrice18 stays 0.
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));

        // commit subsidy R while still Running
        usdc.mint(owner, 100e6);
        vm.prank(owner);
        usdc.approve(address(arena), 100e6);
        vm.prank(owner);
        arena.fundSubsidy(id, 100e6);

        // warp past endTime + GRACE; emergencySettle refunds ALL conviction 1:1 (both sides).
        e = arena.getEpoch(id);
        vm.warp(uint256(e.endTime) + arena.GRACE() + 1);

        uint256 upBefore = usdc.balanceOf(up);
        uint256 downBefore = usdc.balanceOf(down);
        uint256 rollBefore = arena.rolloverUSDC();

        vm.prank(owner);
        arena.emergencySettle(id, IFeeArena.Side.RANGE);

        // Both sides refunded 1:1.
        assertEq(usdc.balanceOf(up) - upBefore, 400e6, "UP conviction refunded");
        assertEq(usdc.balanceOf(down) - downBefore, 300e6, "DOWN conviction refunded");
        // committed R rolled forward.
        assertEq(arena.rolloverUSDC() - rollBefore, 100e6, "R rolled forward");
        assertEq(arena.totalCustodiedConviction(), 0, "live conviction retired");
        assertEq(arena.totalCommittedSubsidy(), 0, "committed subsidy retired");

        e = arena.getEpoch(id);
        assertEq(uint8(e.phase), uint8(IFeeArena.Phase.Settled), "Settled");
        assertTrue(e.rolledOver, "rolled");

        // positions marked swept -> NFTs unstakeable.
        vm.prank(up);
        arena.unstake(tUp);
        vm.prank(down);
        arena.unstake(tDown);
    }

    function test_Emergency_RevertsOnResolvedEpoch() public {
        // A resolved epoch (settlePrice18 != 0) must NOT be confiscated by emergencySettle.
        uint64 id = _openEntryEpoch();
        _stake(makeAddr("up"), IFeeArena.Side.UP, 400e6);
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));
        e = arena.getEpoch(id);
        vm.warp(uint256(e.endTime));
        oracle.setPrice(3300e18);
        arena.endEpoch(new bytes[](0)); // Resolved, settlePrice18 != 0

        vm.warp(uint256(e.endTime) + arena.GRACE() + 1);
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.EpochResolvable.selector);
        arena.emergencySettle(id, IFeeArena.Side.RANGE);
    }

    function test_Emergency_RevertsBeforeGrace() public {
        uint64 id = _openEntryEpoch();
        _stake(makeAddr("up"), IFeeArena.Side.UP, 400e6);
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));
        e = arena.getEpoch(id);
        // just at endTime + GRACE (not strictly past) -> still too early.
        vm.warp(uint256(e.endTime) + arena.GRACE());
        vm.prank(owner);
        vm.expectRevert(IFeeArena.GraceNotElapsed.selector);
        arena.emergencySettle(id, IFeeArena.Side.RANGE);
    }

    receive() external payable {}
}
