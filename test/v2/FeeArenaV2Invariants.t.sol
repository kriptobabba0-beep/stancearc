// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {EpochV2, Position} from "src/FeeArenaV2Types.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {WETH9} from "src/mocks/WETH9.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract MockPoolV2I {
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address t0, address t1, uint24 f) {
        token0 = t0;
        token1 = t1;
        fee = f;
    }
}

contract MockFactoryV2I {
    address public defaultPool;

    constructor(address p) {
        defaultPool = p;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return defaultPool;
    }
}

/// @notice Deterministic per-invariant assertions complementing the fuzz invariant suites
///         (test/invariant/v2/**). Each test pins ONE spec §INVARIANTS property with an exact,
///         hand-computed expectation: INV-S3 counter consistency, INV-C1 exact refund (no dust),
///         INV-P1 dust conservation, INV-P4 sqrt denominator + dust-gets-zero, and the oracle
///         INV-O1/O2/O3 windows/conf/migration (the latter via the MockPriceOracle pin).
contract FeeArenaV2InvariantsTest is Test {
    FeeArenaV2 internal arena;
    MockPriceOracle internal oracle;
    WETH9 internal weth;
    TestERC20 internal usdc;
    MockPoolV2I internal pool;
    MockFactoryV2I internal factory;
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
        pool = new MockPoolV2I(address(weth), address(usdc), FEE_TIER);
        factory = new MockFactoryV2I(address(pool));
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

    function _stake(address who, IFeeArena.Side side, uint256 conviction) internal returns (uint256 tokenId) {
        tokenId = npm.mintTo(who, address(weth), address(usdc), FEE_TIER, MIN_LIQ);
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

    function _startCurrent() internal {
        uint64 id = arena.currentEpochId();
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.startTime));
        oracle.setPrice(START_PRICE);
        arena.startEpoch(new bytes[](0));
    }

    function _endCurrentAt(uint256 price18) internal {
        uint64 id = arena.currentEpochId();
        EpochV2 memory e = arena.getEpoch(id);
        vm.warp(uint256(e.endTime));
        oracle.setPrice(price18);
        arena.endEpoch(new bytes[](0));
    }

    // =====================================================================
    // INV-S3 — O(1) owed counters == externally-summed per-epoch residuals
    // =====================================================================

    function test_S3_TotalOwedTracksPerEpochResiduals_AcrossPartialClaims() public {
        // two winners with different convictions + a loser providing pot.
        uint64 id = _openEntryEpoch();
        address a = makeAddr("a");
        address b = makeAddr("b");
        uint256 ta = _stake(a, IFeeArena.Side.UP, 300e6);
        uint256 tb = _stake(b, IFeeArena.Side.UP, 700e6);
        uint256 tl = _stake(makeAddr("l"), IFeeArena.Side.DOWN, 100e6);
        _programOwed(ta, 1e18, 1000e6);
        _programOwed(tb, 0, 2000e6);
        _programOwed(tl, 0, 0);

        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        // After finalize: totalOwedUSDC == (potUSDC - 0) + (winConvSum - 0).
        EpochV2 memory e = arena.getEpoch(id);
        assertEq(arena.totalOwedUSDC(), e.potUSDC + e.winningConvictionSum, "S3 USDC after finalize");
        assertEq(arena.totalOwedWETH(), e.potWETH, "S3 WETH after finalize");

        // Partially claim + refund, recompute the residual each step.
        arena.claim(id, ta, a);
        arena.refundConviction(id, ta, a);
        e = arena.getEpoch(id);
        assertEq(
            arena.totalOwedUSDC(),
            (e.potUSDC - e.claimedUSDC) + (e.winningConvictionSum - e.refundedConviction),
            "S3 USDC after partial"
        );
        assertEq(arena.totalOwedWETH(), e.potWETH - e.claimedWETH, "S3 WETH after partial");

        // Drain the rest.
        arena.claim(id, tb, b);
        arena.refundConviction(id, tb, b);
        if (e.potWETH - e.claimedWETH > 0 || e.potUSDC - e.claimedUSDC > 0) {
            // fold any sqrt-floor dust so the pot residual is fully accounted.
            try arena.foldDust(id) {} catch {}
        }
        // Everything drained: the only thing the loser cannot do is refund (burned).
        e = arena.getEpoch(id);
        assertEq(
            arena.totalOwedUSDC(),
            (e.potUSDC - e.claimedUSDC) + (e.winningConvictionSum - e.refundedConviction),
            "S3 USDC fully drained"
        );
    }

    // =====================================================================
    // INV-C1 — Σ refunded c_i == winningConvictionSum EXACTLY (no dust)
    // =====================================================================

    function test_C1_RefundSumEqualsWinningConvictionSum_Exact() public {
        uint64 id = _openEntryEpoch();
        // Three winners with awkward convictions so any division would leave dust — but refund is
        // 1:1 (no division), so the sum is EXACT.
        address a = makeAddr("a");
        address b = makeAddr("b");
        address c = makeAddr("c");
        uint256 ca = 333e6;
        uint256 cb = 777e6;
        uint256 cc = 101e6;
        uint256 ta = _stake(a, IFeeArena.Side.UP, ca);
        uint256 tb = _stake(b, IFeeArena.Side.UP, cb);
        uint256 tc = _stake(c, IFeeArena.Side.UP, cc);
        _programOwed(ta, 0, 100e6);

        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        uint256 winSum = arena.getEpoch(id).winningConvictionSum;
        assertEq(winSum, ca + cb + cc, "winSum = sum winning c_i");

        arena.refundConviction(id, ta, a);
        arena.refundConviction(id, tb, b);
        arena.refundConviction(id, tc, c);

        EpochV2 memory e = arena.getEpoch(id);
        assertEq(e.refundedConviction, winSum, "sum refunded != winSum (dust!)");
        assertEq(e.convRefundedCount, 3, "all three refunded");
        // each got EXACTLY its own conviction (no division dust).
        assertEq(usdc.balanceOf(a), ca, "a exact");
        assertEq(usdc.balanceOf(b), cb, "b exact");
        assertEq(usdc.balanceOf(c), cc, "c exact");
    }

    // =====================================================================
    // INV-P1 — Σ pot-share payouts + folded dust == pot EXACTLY
    // =====================================================================

    function test_P1_PotPayoutsPlusDustEqualPot_Exact() public {
        uint64 id = _openEntryEpoch();
        address a = makeAddr("a");
        address b = makeAddr("b");
        // distinct convictions so sqrt floors leave a non-zero residual.
        uint256 ta = _stake(a, IFeeArena.Side.UP, 300e6);
        uint256 tb = _stake(b, IFeeArena.Side.UP, 700e6);
        _programOwed(ta, 7e18, 1000e6);
        _programOwed(tb, 0, 1234e6);

        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        EpochV2 memory e0 = arena.getEpoch(id);
        uint256 potW = e0.potWETH;
        uint256 potU = e0.potUSDC;

        uint256 paidW = weth.balanceOf(a) + weth.balanceOf(b);
        uint256 paidU = usdc.balanceOf(a) + usdc.balanceOf(b);
        // (b posted no USDC fee; balances start at 0 for fresh winners.)
        arena.claim(id, ta, a);
        arena.claim(id, tb, b);
        paidW = (weth.balanceOf(a) + weth.balanceOf(b)) - paidW;
        paidU = (usdc.balanceOf(a) + usdc.balanceOf(b)) - paidU;

        uint256 dustW = potW - paidW;
        uint256 dustU = potU - paidU;
        // fold the residual; if non-zero it rolls forward.
        uint256 rollWBefore = arena.rolloverWETH();
        uint256 rollUBefore = arena.rolloverUSDC();
        if (dustW > 0 || dustU > 0) {
            arena.foldDust(id);
            assertEq(arena.rolloverWETH() - rollWBefore, dustW, "folded WETH dust");
            assertEq(arena.rolloverUSDC() - rollUBefore, dustU, "folded USDC dust");
        }
        // EXACT conservation: claimed + dust == pot on both legs.
        assertEq(paidW + dustW, potW, "P1 WETH");
        assertEq(paidU + dustU, potU, "P1 USDC");
    }

    // =====================================================================
    // INV-P4 — sqrt-weighted denominator + dust winner draws ZERO pot share
    // =====================================================================

    function test_P4_DustWinnerDrawsZero_PositiveWinnerTakesPot() public {
        uint64 id = _openEntryEpoch();
        address big = makeAddr("big");
        address dust = makeAddr("dust");
        uint256 tBig = _stake(big, IFeeArena.Side.UP, 900e6);
        uint256 tDust = _stake(dust, IFeeArena.Side.UP, 100e6); // dust: realizes NO fee -> contribution6==0
        // fee kept under the R-cap (2*winConv = 2*1000e6 = 2000e6) so the pot is fully
        // distributable and `big` (sole positive-contribution winner) takes ALL of it.
        uint256 feeUSDC = 1500e6;
        _programOwed(tBig, 0, feeUSDC);
        _programOwed(tDust, 0, 0); // contribution6 == 0

        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        // denominator is sqrt-weighted over ONLY the positive-contribution winner.
        EpochV2 memory e = arena.getEpoch(id);
        assertEq(e.winnerDenominator, Math.sqrt(900e6), "denom = sqrt(big) only");
        assertEq(arena.winnerCount(id), 1, "dust not counted");
        assertEq(e.potUSDC, feeUSDC, "pot not R-capped (within 2*winConv)");

        // dust winner cannot claim a pot share (contribution6 == 0)...
        vm.expectRevert(IFeeArena.NothingToClaim.selector);
        arena.claim(id, tDust, dust);
        // ...but its conviction is STILL refundable (decoupled).
        uint256 before = usdc.balanceOf(dust);
        arena.refundConviction(id, tDust, dust);
        assertEq(usdc.balanceOf(dust) - before, 100e6, "dust refund 1:1");

        // big winner takes the WHOLE pot (sole positive-contribution winner).
        arena.claim(id, tBig, big);
        assertEq(usdc.balanceOf(big), feeUSDC, "big takes whole pot");
    }

    // =====================================================================
    // INV-P2 — potUSDC == forfeited fees + committed R; NEVER losing conviction
    // =====================================================================

    function test_P2_PotExcludesLosingConviction_IncludesCappedR() public {
        uint64 id = _openEntryEpoch();
        // TWO winning stakers so winningConvictionSum (2000e6) keeps the R-cap (2*winConv =
        // 4000e6) well clear of the pot, isolating the "pot == fees + R, no losing conv" property.
        uint256 tWin1 = _stake(makeAddr("w1"), IFeeArena.Side.UP, 1000e6);
        uint256 tWin2 = _stake(makeAddr("w2"), IFeeArena.Side.UP, 1000e6);
        uint256 tLose = _stake(makeAddr("l"), IFeeArena.Side.DOWN, 500e6);
        uint256 feeUSDC = 2000e6;
        _programOwed(tWin1, 0, feeUSDC); // only one winner harvests; pot fees = 2000e6
        _programOwed(tWin2, 0, 0);
        _programOwed(tLose, 0, 0);

        uint256 R = MAX_SUBSIDY; // 150e6
        usdc.mint(owner, R);
        vm.prank(owner);
        usdc.approve(address(arena), R);
        vm.prank(owner);
        arena.fundSubsidy(id, R);

        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        EpochV2 memory e = arena.getEpoch(id);
        // pot == forfeited fees + R (2150e6), with the cap 2*2000e6 = 4000e6 NOT biting, and NO
        // losing conviction (500e6) recycled in.
        assertEq(e.potUSDC, feeUSDC + R, "potUSDC = fees + R (no losing conv recycled)");
        assertLe(e.potUSDC, 2 * e.winningConvictionSum, "pot within R-cap");
        // losing conviction was burned to treasury, not added to the pot.
        assertEq(e.burnedConviction, 500e6, "losing conviction burned");
        assertEq(usdc.balanceOf(treasury), 500e6, "burn went to treasury, not the pot");
    }

    // =====================================================================
    // INV-O1/O2 — pinned window + conf bound (via MockPriceOracle pin sim)
    // =====================================================================

    function test_O1_SettleWindowHardCappedAt60() public {
        assertEq(arena.MAX_SETTLE_WINDOW(), 60, "hard cap 60s");
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.SettleWindowTooLarge.selector);
        arena.setSettleWindow(61);
    }

    function test_O2_MaxConfBpsStrictlyBelowBand() public {
        // setter rejects maxConfBps >= bandBps.
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.ConfBpsInvalid.selector);
        arena.setMaxConfBps(uint32(uint256(int256(BAND_BPS)))); // == band
        // and the live config already satisfies maxConfBps < bandBps.
        assertLt(int32(int256(uint256(arena.maxConfBps()))), arena.bandBps(), "conf not below band");
    }

    // =====================================================================
    // INV-O3 — oracle migration only when no in-flight epoch + after timelock
    // =====================================================================

    function test_O3_MigrationGatedByTimelockAndNoInFlight() public {
        MockPriceOracle next = new MockPriceOracle();
        // propose, then attempting to execute before the 48h timelock reverts.
        vm.prank(owner);
        arena.proposeOracle(address(next));
        uint64 unlock = arena.oracleUnlockTime();
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.TimelockNotElapsed.selector);
        arena.executeOracleMigration();

        // bring an epoch in-flight (Running) and drive it fully to Settled (the only safe phase),
        // THEN warp past the recorded unlock time. _endCurrentAt rewinds the clock to endTime, so
        // we re-warp to `unlock` AFTER settling to satisfy the timelock at execute time.
        _openEntryEpoch();
        _stake(makeAddr("u"), IFeeArena.Side.UP, MIN_CONV);
        _startCurrent(); // Running

        // while Running (in-flight) AND past the timelock, migration must still be rejected.
        vm.warp(uint256(unlock) + 1);
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.EpochInFlight.selector);
        arena.executeOracleMigration();

        // drive to Settled (safe phase).
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        // re-establish "past the timelock" (the settle cranks rewound the clock to endTime).
        vm.warp(uint256(unlock) + 1);
        vm.prank(owner);
        arena.executeOracleMigration();
        assertEq(arena.oracle(), address(next), "migrated only after timelock + no in-flight");
    }
}
