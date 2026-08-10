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

contract MockPoolV2E {
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address t0, address t1, uint24 f) {
        token0 = t0;
        token1 = t1;
        fee = f;
    }
}

contract MockFactoryV2E {
    address public defaultPool;

    constructor(address p) {
        defaultPool = p;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return defaultPool;
    }
}

/// @notice ECONOMIC property tests (spec §INVARIANTS ECONOMIC), encoding the red-team EV
///         reasoning as on-chain, end-to-end-measured properties driven through the REAL contract:
///
///   INV-EV1: under FULL cross-wallet sybil (an all-sides hedger covering UP/DOWN/RANGE across
///            separate wallets), the hedger's net USDC EV is <= 0 under BURN + R-cap + dust-gate.
///            The decisive lever: the two losing legs are BURNED (2*minConv) and the per-epoch
///            subsidy R is dust-gated below 2*minConv, so even when the hedger is the SOLE staker
///            (capturing the entire R-capped pot) his net is strictly negative.
///
///   INV-EV2: a correct single-side staker with R>0 is STRICTLY +EV vs vanilla LPing — he keeps
///            his conviction (refunded 1:1) AND captures the subsidy R on top of his harvested
///            fees, which a vanilla LP (who forfeits nothing and gains no R) never receives.
contract FeeArenaV2EconomicTest is Test {
    FeeArenaV2 internal arena;
    MockPriceOracle internal oracle;
    WETH9 internal weth;
    TestERC20 internal usdc;
    MockPoolV2E internal pool;
    MockFactoryV2E internal factory;
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
    uint256 internal constant MAX_SUBSIDY = 150e6; // < 2*minConv = 200e6 (dust-gate)

    uint256 internal constant START_PRICE = 3000e18;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(100);
        weth = new WETH9();
        usdc = new TestERC20("USD Coin", "USDC", 6);
        oracle = new MockPriceOracle();
        pool = new MockPoolV2E(address(weth), address(usdc), FEE_TIER);
        factory = new MockFactoryV2E(address(pool));
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

    function _fundSubsidy(uint64 id, uint256 amount) internal {
        usdc.mint(owner, amount);
        vm.prank(owner);
        usdc.approve(address(arena), amount);
        vm.prank(owner);
        arena.fundSubsidy(id, amount);
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
    // INV-EV1 — all-sides hedger EV <= 0 (BURN + R-cap + dust-gate)
    // =====================================================================

    /// @notice Worst case for the protocol: a 3-wallet hedger is the SOLE staker on each side, so
    ///         whichever side wins he captures the ENTIRE pot (R + any forfeited fees). With R
    ///         dust-gated below 2*minConv and the two losing legs BURNED, his net is strictly
    ///         negative even though he wins the whole pot. He posts NO LP fees here (pure
    ///         conviction hedge), so pot == R only.
    function test_EV1_AllSidesHedger_PureConviction_NetNegative() public {
        uint64 id = _openEntryEpoch();

        // 3 distinct wallets, one per side, each at minConv (cheapest cover).
        address wUp = makeAddr("hedgeUp");
        address wDown = makeAddr("hedgeDown");
        address wRange = makeAddr("hedgeRange");
        uint256 tUp = _stake(wUp, IFeeArena.Side.UP, MIN_CONV);
        uint256 tDown = _stake(wDown, IFeeArena.Side.DOWN, MIN_CONV);
        uint256 tRange = _stake(wRange, IFeeArena.Side.RANGE, MIN_CONV);

        // Force the winning leg to be a POSITIVE-contribution winner so it can claim the pot
        // (otherwise the pot rolls forward and the hedger captures nothing — even more negative).
        // Give the UP leg a tiny realized fee so contribution6>0; that fee is the hedger's OWN
        // forfeited LP fee, so it counts as value IN for him.
        uint256 ownFeeUSDC = 5e6;
        _programOwed(tUp, 0, ownFeeUSDC);

        // Owner commits the MAX subsidy R (the most a hedger could ever farm).
        _fundSubsidy(id, MAX_SUBSIDY);

        // total USDC the hedger put AT RISK: 3 legs of conviction + the one leg's forfeited fee.
        uint256 hedgerIn = 3 * MIN_CONV + ownFeeUSDC;

        _startCurrent();
        _endCurrentAt(3300e18); // +10% -> UP wins (the contribution>0 leg)
        arena.sweep(10);
        arena.finalizeSettle();

        // Hedger reclaims: winning-leg conviction refund (1:1) + the winning-leg pot share.
        uint256 outBefore = usdc.balanceOf(wUp);
        arena.refundConviction(id, tUp, wUp);
        arena.claim(id, tUp, wUp);
        uint256 hedgerOut = usdc.balanceOf(wUp) - outBefore;
        // losing legs (DOWN/RANGE) are NOT refundable — they were burned to treasury.

        // Sanity: the losing legs really were burned.
        assertEq(arena.getEpoch(id).burnedConviction, 2 * MIN_CONV, "two legs burned");
        // Sanity: the winning leg's pot is at most the R-cap (2*winConv) AND bounded by R+fees.
        EpochV2 memory e = arena.getEpoch(id);
        assertLe(e.potUSDC, 2 * e.winningConvictionSum, "pot within R-cap");

        // THE PROPERTY: net EV <= 0. The hedger never gets back more than he put in.
        assertLe(hedgerOut, hedgerIn, "all-sides hedger is NOT non-positive-EV");
        // And it is STRICTLY negative here (he lost the two burned legs minus the captured R+fee):
        // out = MIN_CONV (refund) + (R + ownFee) ; in = 3*MIN_CONV + ownFee.
        // net = R - 2*MIN_CONV < 0 by the dust-gate (R = MAX_SUBSIDY < 2*MIN_CONV).
        assertLt(hedgerOut, hedgerIn, "hedger net not strictly negative");
        assertEq(hedgerIn - hedgerOut, 2 * MIN_CONV - MAX_SUBSIDY, "net loss == 2*minConv - R");
    }

    /// @notice The dust-gate is the invariant that makes EV1 hold for ANY admissible R: the cheapest
    ///         two-leg burn (2*minConv) strictly exceeds the per-epoch subsidy cap, so the most a
    ///         hedger can farm (the whole R) never offsets the two legs he forfeits.
    function test_EV1_DustGate_TwoLegBurnExceedsSubsidyCap() public view {
        assertLt(arena.maxSubsidyPerEpoch(), 2 * arena.minConv(), "dust-gate broken: R >= 2*minConv");
    }

    /// @notice Fuzz the hedger's conviction split across the three legs (each in [minConv,maxConv])
    ///         with the winning leg always the sole positive-contribution winner capturing the
    ///         whole (R-capped) pot. Net EV must be <= 0 for EVERY split.
    function test_EV1_AllSidesHedger_FuzzedSplit_NetNonPositive(uint256 cUp, uint256 cDown, uint256 cRange) public {
        cUp = bound(cUp, MIN_CONV, MAX_CONV);
        cDown = bound(cDown, MIN_CONV, MAX_CONV);
        cRange = bound(cRange, MIN_CONV, MAX_CONV);

        uint64 id = _openEntryEpoch();
        address wUp = makeAddr("fUp");
        address wDown = makeAddr("fDown");
        address wRange = makeAddr("fRange");
        uint256 tUp = _stake(wUp, IFeeArena.Side.UP, cUp);
        _stake(wDown, IFeeArena.Side.DOWN, cDown);
        _stake(wRange, IFeeArena.Side.RANGE, cRange);

        uint256 ownFeeUSDC = 5e6;
        _programOwed(tUp, 0, ownFeeUSDC);
        _fundSubsidy(id, MAX_SUBSIDY);

        uint256 hedgerIn = cUp + cDown + cRange + ownFeeUSDC;

        _startCurrent();
        _endCurrentAt(3300e18); // UP wins (sole positive-contribution winner)
        arena.sweep(10);
        arena.finalizeSettle();

        uint256 outBefore = usdc.balanceOf(wUp);
        arena.refundConviction(id, tUp, wUp);
        arena.claim(id, tUp, wUp);
        uint256 hedgerOut = usdc.balanceOf(wUp) - outBefore;

        // EV <= 0 for every conviction split. (Out = cUp refund + whole capped pot;
        // In = cUp + cDown + cRange + ownFee. The two burned legs cDown+cRange >= 2*minConv > R+fee.)
        assertLe(hedgerOut, hedgerIn, "fuzzed all-sides hedger positive-EV");
    }

    // =====================================================================
    // INV-EV2 — a correct single-side staker with R>0 is strictly +EV
    // =====================================================================

    /// @notice A correct directional staker (sole winner) vs a vanilla LP holding the SAME position.
    ///         Both harvest the same LP fee. The staker additionally: (a) gets his conviction back
    ///         1:1, and (b) captures the subsidy R via the pot. So staker_out - staker_in > vanilla
    ///         (whose net over the epoch is exactly its harvested fee, gaining no R). With R>0 the
    ///         staker strictly beats vanilla by (at least) R.
    function test_EV2_CorrectStaker_StrictlyBeatsVanillaByR() public {
        uint64 id = _openEntryEpoch();
        address staker = makeAddr("skill");
        // conviction maxConv so the R-cap (2*winConv = 2000e6) comfortably exceeds his own
        // forfeited fee + R (1000e6 + 150e6) — the cap is there to bound a THIN-conviction
        // R-farm, not to claw back a well-capitalized correct staker's own fees + edge.
        uint256 conv = 1000e6;
        uint256 tWin = _stake(staker, IFeeArena.Side.UP, conv);

        // the staker's own LP harvests a fee (forfeited into the pot at sweep).
        uint256 ownFeeUSDC = 1000e6;
        uint256 ownFeeWETH = 1e18;
        _programOwed(tWin, ownFeeWETH, ownFeeUSDC);

        // a wrong-side loser provides extra pot + their burned conviction (does not help staker EV
        // beyond the pot fees; conviction is burned, never recycled).
        uint256 tLose = _stake(makeAddr("wrong"), IFeeArena.Side.DOWN, 200e6);
        _programOwed(tLose, 0, 0);

        // subsidy R committed (the lever that makes skill strictly +EV).
        uint256 R = MAX_SUBSIDY;
        _fundSubsidy(id, R);

        _startCurrent();
        _endCurrentAt(3300e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();

        // Cash accounting relative to the staker's starting position. The ONLY cash he puts at
        // risk is the posted conviction `conv` — the LP fee is forfeited FROM the position into the
        // pot (it was never in his pocket; it is exactly what the vanilla LP would have kept). So:
        //   staker net USDC = (refund + pot USDC share) - conv
        //   vanilla net USDC = ownFeeUSDC (the fee a non-staking LP simply keeps)
        uint256 usdcBefore = usdc.balanceOf(staker);
        uint256 wethBefore = weth.balanceOf(staker);
        arena.refundConviction(id, tWin, staker);
        arena.claim(id, tWin, staker);
        uint256 outUSDC = usdc.balanceOf(staker) - usdcBefore;
        uint256 outWETH = weth.balanceOf(staker) - wethBefore;

        int256 stakerNetUSDC = int256(outUSDC) - int256(conv);
        int256 vanillaNetUSDC = int256(ownFeeUSDC); // vanilla just keeps its own USDC fee

        // The staker's WETH leg equals his own forfeited WETH fee (sole winner reclaims the pot),
        // so the WETH legs cancel between staker and vanilla — the edge is entirely in USDC (R).
        assertEq(outWETH, ownFeeWETH, "sole winner reclaims own WETH fee via pot");

        assertGt(stakerNetUSDC, vanillaNetUSDC, "correct staker not strictly +EV vs vanilla");
        // The edge is EXACTLY the subsidy R (he recovered his own fee AND captured R on top).
        assertEq(stakerNetUSDC - vanillaNetUSDC, int256(R), "edge != committed subsidy R");
    }

    /// @notice Without R (R==0) the mechanism is break-even-on-conviction + harvested fees only:
    ///         a sole correct staker exactly recovers his conviction + his own forfeited fee
    ///         (net == 0 vs the fee he'd have kept), confirming R is the lever (spec §SUBSIDYFLOW).
    function test_EV2_NoSubsidy_SoleStakerBreaksEvenOnConviction() public {
        uint64 id = _openEntryEpoch();
        address staker = makeAddr("noR");
        // maxConv so the R-cap (2*winConv = 2000e6) does not claw back his own forfeited fee.
        uint256 conv = 1000e6;
        uint256 tWin = _stake(staker, IFeeArena.Side.UP, conv);
        uint256 ownFeeUSDC = 1000e6;
        _programOwed(tWin, 0, ownFeeUSDC);

        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        uint256 before = usdc.balanceOf(staker);
        arena.refundConviction(id, tWin, staker);
        arena.claim(id, tWin, staker);
        uint256 got = usdc.balanceOf(staker) - before;

        // He posted conv + forfeited ownFeeUSDC; he recovers exactly conv (refund) + ownFeeUSDC
        // (the whole pot, being the sole winner). Net == 0 with no R — break-even on conviction.
        assertEq(got, conv + ownFeeUSDC, "no-R sole staker not exactly break-even");
    }
}
