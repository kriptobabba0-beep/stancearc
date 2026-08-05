// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FeeArena} from "../src/FeeArena.sol";
import {IFeeArena} from "../src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {WETH9} from "../src/mocks/WETH9.sol";
import {TestERC20} from "../src/mocks/TestERC20.sol";
import {Config} from "./config/Config.sol";
import {V3Deployer} from "../test/utils/V3Deployer.sol";

/// @notice Scripted end-to-end demo that drives EVERY Fee Arena outcome branch
///         deterministically (spec §7.4): UP-win, DOWN-win, RANGE-win, and empty-winner
///         rollover. Two ways to drive it:
///         1. {run} - self-contained: deploys a REAL =0.7.6 Uniswap V3 fork + mocks + pool +
///            FeeArena, then runs all four branches with REAL swaps that accrue REAL fees,
///            logging the ArcScan-visible lifecycle events. This is the local-simulation
///            verification path (`forge script script/DemoFlow.s.sol` with no --broadcast).
///         2. The hook-driven branch runners ({runUpWin}, {runDownWin}, {runRangeWin},
///            {runEmptyWinnerThenNormal}) - usable from a unit test that injects its own
///            mint/stake/swap behaviour against any FeeArena instance.
contract DemoFlow is Script, Config {
    struct Actors {
        address lpUp1;
        address lpUp2;
        address lpDown;
        address lpRange;
    }

    /// @dev Pluggable hooks let a unit test supply mint/stake/swap behaviour while {run}
    ///      uses the real V3 fork. Each mint/stake hook returns the staked tokenId.
    struct Hooks {
        function(address) external returns (uint256) mintAndStakeUp;
        function(address) external returns (uint256) mintAndStakeDown;
        function(address) external returns (uint256) mintAndStakeRange;
        function() external runSwaps;
    }

    // =====================================================================
    // Pure preset
    // =====================================================================

    /// @notice Force-preset settle price: UP clears +band by a margin, DOWN clears -band,
    ///         RANGE == start. The +50bps margin guarantees integer truncation in
    ///         OutcomeResolver can never flip the decision back to RANGE.
    function forcePrice(uint256 startPrice18, int32 bandBps, IFeeArena.Side side) public pure returns (uint256) {
        require(side != IFeeArena.Side.NONE, "NONE");
        uint256 band = uint256(uint32(bandBps));
        uint256 marginBps = band + 50;
        if (side == IFeeArena.Side.UP) {
            return startPrice18 + (startPrice18 * marginBps) / 10_000;
        } else if (side == IFeeArena.Side.DOWN) {
            return startPrice18 - (startPrice18 * marginBps) / 10_000;
        }
        return startPrice18; // RANGE
    }

    // =====================================================================
    // Hook-driven lifecycle helpers (unit-test path)
    // =====================================================================

    /// @notice Crank a Running (or about-to-start) epoch through end -> sweep -> finalize at
    ///         the forced settle price. Owner-gated calls are pranked to the arena owner; the
    ///         oracle is set by its ACTUAL owner (read on-chain, not assumed). `forced` selects
    ///         the outcome; if `stakeUp` is false the UP side is empty (empty-winner branch when
    ///         forced==UP).
    function _fullCycle(
        address arena_,
        address oracle_,
        address owner_,
        Actors memory a,
        Hooks memory h,
        IFeeArena.Side forced,
        bool stakeUp
    ) internal returns (uint64 epochId) {
        FeeArena arena = FeeArena(payable(arena_));
        vm.prank(owner_);
        epochId = arena.createEpoch();
        vm.prank(owner_);
        arena.openEntry();

        if (stakeUp) {
            h.mintAndStakeUp(a.lpUp1);
            h.mintAndStakeUp(a.lpUp2);
        }
        h.mintAndStakeDown(a.lpDown);
        h.mintAndStakeRange(a.lpRange);

        // start (price captured at/after entryClose), then swaps accrue fees while Running.
        IFeeArena.EpochView memory ev = arena.getEpoch(epochId);
        vm.warp(uint256(ev.entryCloseTime) + 1);
        vm.roll(block.number + 1);
        _setOracle(oracle_, _startPriceForCurrent(arena_));
        arena.startEpoch(new bytes[](0));
        h.runSwaps();

        // force the outcome BEFORE endEpoch, then end -> sweep -> finalize.
        ev = arena.getEpoch(epochId);
        uint256 settle = forcePrice(ev.startPrice18, ev.bandBps, forced);
        vm.warp(uint256(ev.endTime) + 1);
        vm.roll(block.number + 1);
        _setOracle(oracle_, settle);
        bytes[] memory empty = new bytes[](0);
        arena.endEpoch(empty);

        _sweepToEnd(arena, epochId);
        arena.finalizeSettle();
    }

    /// @notice Full UP-win branch (2xUP, 1xDOWN, 1xRANGE staked; Force-UP).
    function runUpWin(address arena_, address oracle_, address owner_, Actors memory a, Hooks memory h)
        public
        returns (uint64)
    {
        return _fullCycle(arena_, oracle_, owner_, a, h, IFeeArena.Side.UP, true);
    }

    /// @notice Full DOWN-win branch (Force-DOWN; DOWN staker wins).
    function runDownWin(address arena_, address oracle_, address owner_, Actors memory a, Hooks memory h)
        public
        returns (uint64)
    {
        return _fullCycle(arena_, oracle_, owner_, a, h, IFeeArena.Side.DOWN, true);
    }

    /// @notice Full RANGE-win branch (Force-RANGE; RANGE staker wins).
    function runRangeWin(address arena_, address oracle_, address owner_, Actors memory a, Hooks memory h)
        public
        returns (uint64)
    {
        return _fullCycle(arena_, oracle_, owner_, a, h, IFeeArena.Side.RANGE, true);
    }

    /// @notice Empty-winner branch: epoch1 stakes ONLY DOWN/RANGE then Force-UP -> winning side
    ///         contribution == 0 -> whole pot rolls forward (EmptyWinnerRollover). Epoch2 is a
    ///         normal UP-win cycle whose finalizeSettle injects the carried pot (RolloverInjected).
    function runEmptyWinnerThenNormal(address arena_, address oracle_, address owner_, Actors memory a, Hooks memory h)
        public
        returns (uint64 e1, uint64 e2)
    {
        e1 = _fullCycle(arena_, oracle_, owner_, a, h, IFeeArena.Side.UP, false);
        e2 = _fullCycle(arena_, oracle_, owner_, a, h, IFeeArena.Side.UP, true);
    }

    // ---- shared lifecycle internals ----

    function _sweepToEnd(FeeArena arena, uint64 epochId) internal {
        (uint32 done, uint32 total) = arena.sweepProgress(epochId);
        while (done < total) {
            arena.sweep(64);
            (done, total) = arena.sweepProgress(epochId);
        }
    }

    /// @dev Set the oracle price under its ACTUAL owner (never assumes `owner_` owns it).
    function _setOracle(address oracle_, uint256 price18) internal {
        vm.prank(Ownable(oracle_).owner());
        MockPriceOracle(oracle_).setPrice(price18);
    }

    /// @dev Deterministic start price for each cycle (the demo default).
    function _startPriceForCurrent(address) internal pure returns (uint256) {
        return DEFAULT_PRICE_18;
    }

    function run() external {
        // Self-contained local-simulation demo: deploy a real V3 fork + mocks + pool + arena,
        // then drive all four branches with real swaps. No --broadcast needed to verify.
        _runAllBranchesRealV3();
    }

    // =====================================================================
    // Self-contained REAL-V3 demo ({run}) - drives all four branches with real fees.
    // =====================================================================

    // live handles for the self-contained demo (set in _bootstrapRealV3)
    FeeArena internal A;
    MockPriceOracle internal O;
    WETH9 internal W;
    TestERC20 internal U;
    V3Deployer.V3 internal v3;
    address internal demoOwner;

    function _runAllBranchesRealV3() internal {
        // A dedicated owner address (NOT address(this): forge-script forbids reading the
        // ephemeral script address). All owner-gated cranks + oracle setPrice are pranked to it.
        demoOwner = makeAddr("demoOwner");
        _bootstrapRealV3();

        console2.log("=================================================================");
        console2.log("Fee Arena V0 - end-to-end demo (real Uniswap V3 fork, real fees)");
        console2.log("FeeArena :", address(A));
        console2.log("Oracle   :", address(O));
        console2.log("Pool     :", A.POOL());
        console2.log("=================================================================");

        uint64 e1 = _demoBranch(IFeeArena.Side.UP, true, "UP-WIN");
        _logWinners(e1, IFeeArena.Side.UP);

        uint64 e2 = _demoBranch(IFeeArena.Side.DOWN, true, "DOWN-WIN");
        _logWinners(e2, IFeeArena.Side.DOWN);

        uint64 e3 = _demoBranch(IFeeArena.Side.RANGE, true, "RANGE-WIN");
        _logWinners(e3, IFeeArena.Side.RANGE);

        // empty-winner: stake only DOWN/RANGE, Force UP -> rollover; next normal cycle injects it.
        console2.log("");
        console2.log("--- BRANCH: EMPTY-WINNER ROLLOVER ---");
        uint256 rollBeforeW = A.rolloverWETH();
        uint256 rollBeforeU = A.rolloverUSDC();
        uint64 e4 = _demoBranch(IFeeArena.Side.UP, false, "EMPTY-WINNER (Force UP, no UP stakers)");
        IFeeArena.EpochView memory ev4 = A.getEpoch(e4);
        console2.log("epoch", e4, "rolledOver:", ev4.rolledOver);
        console2.log("epoch winnerDenominator (0 => empty):", ev4.winnerDenominator);
        console2.log("global rolloverWETH after empty winner:", A.rolloverWETH());
        console2.log("global rolloverUSDC after empty winner:", A.rolloverUSDC());
        require(ev4.rolledOver, "empty-winner did not roll over");
        require(ev4.winnerDenominator == 0, "empty winner should have zero denominator");
        require(A.rolloverWETH() + A.rolloverUSDC() > rollBeforeW + rollBeforeU, "rollover did not grow");

        // next epoch absorbs the rollover at finalizeSettle (RolloverInjected).
        uint64 e5 = _demoBranch(IFeeArena.Side.UP, true, "ROLLOVER-INJECTED next epoch (UP-win)");
        IFeeArena.EpochView memory ev5 = A.getEpoch(e5);
        console2.log("next epoch", e5, "potWETH (incl. injected rollover):", ev5.potWETH);
        console2.log("next epoch potUSDC (incl. injected rollover):", ev5.potUSDC);
        console2.log("global rolloverWETH after injection (==0):", A.rolloverWETH());
        console2.log("global rolloverUSDC after injection (==0):", A.rolloverUSDC());
        require(A.rolloverWETH() == 0 && A.rolloverUSDC() == 0, "rollover not consumed");
        _logWinners(e5, IFeeArena.Side.UP);

        console2.log("");
        console2.log("=================================================================");
        console2.log("ALL FOUR BRANCHES RESOLVED: UP / DOWN / RANGE / EMPTY-WINNER ROLLOVER");
        console2.log("=================================================================");
    }

    /// @dev Deploy WETH9 + USDC(6) + real V3 fork + pool + oracle(seeded) + FeeArena.
    function _bootstrapRealV3() internal {
        vm.warp(1_000_000);
        vm.roll(100);

        W = new WETH9();
        U = new TestERC20("USD Coin", "USDC", 6);
        v3 = V3Deployer.deploy(address(W));

        uint160 sp = _sqrtPriceForPair(address(W), address(U));
        address pool = V3Deployer.createAndInitPool(v3, address(W), address(U), DEFAULT_FEE_TIER, sp);

        O = new MockPriceOracle(); // this contract owns it initially
        O.setPrice(DEFAULT_PRICE_18); // seed under current ownership
        Ownable(address(O)).transferOwnership(demoOwner); // hand off to the demo owner

        A = new FeeArena(_demoBoot(pool));
    }

    function _demoBoot(address pool) internal view returns (IFeeArena.BootConfig memory) {
        return IFeeArena.BootConfig({
            usdc: address(U),
            weth: address(W),
            pool: pool,
            npm: address(v3.npm),
            factory: address(v3.factory),
            oracle: address(O),
            owner: demoOwner,
            feeTier: DEFAULT_FEE_TIER,
            minLiquidity: DEFAULT_MIN_LIQUIDITY,
            entryWindow: DEMO_ENTRY_WINDOW,
            epochDuration: DEMO_EPOCH_DURATION,
            minStartGap: DEFAULT_MIN_START_GAP,
            maxStartDelay: DEFAULT_MAX_START_DELAY,
            maxPriceAge: DEFAULT_MAX_PRICE_AGE,
            bandBps: DEFAULT_BAND_BPS
        });
    }

    /// @dev One full demo branch over the real fork: create+open, stake (optionally UP), start,
    ///      real swaps to accrue fees, force the outcome, end -> sweep -> finalize. Returns the
    ///      settled epoch id. `label` is logged for ArcScan/grant narration.
    function _demoBranch(IFeeArena.Side forced, bool stakeUp, string memory label) internal returns (uint64 epochId) {
        console2.log("");
        console2.log("--- BRANCH:", label);

        vm.prank(demoOwner);
        epochId = A.createEpoch();
        vm.prank(demoOwner);
        A.openEntry();

        if (stakeUp) {
            _mintStake(makeAddr(string.concat(label, "-up1")), IFeeArena.Side.UP);
            _mintStake(makeAddr(string.concat(label, "-up2")), IFeeArena.Side.UP);
        }
        _mintStake(makeAddr(string.concat(label, "-down")), IFeeArena.Side.DOWN);
        _mintStake(makeAddr(string.concat(label, "-range")), IFeeArena.Side.RANGE);

        IFeeArena.EpochView memory ev = A.getEpoch(epochId);
        vm.warp(uint256(ev.entryCloseTime) + 1);
        vm.roll(block.number + 1);
        _setOracle(address(O), DEFAULT_PRICE_18);
        A.startEpoch(new bytes[](0));
        console2.log("started; startPrice18 :", A.getEpoch(epochId).startPrice18);

        _accrueRealFees(2 ether);

        ev = A.getEpoch(epochId);
        uint256 settle = forcePrice(ev.startPrice18, ev.bandBps, forced);
        vm.warp(uint256(ev.endTime) + 1);
        vm.roll(block.number + 1);
        _setOracle(address(O), settle);
        A.endEpoch(new bytes[](0));

        ev = A.getEpoch(epochId);
        console2.log("ended; settlePrice18 :", ev.settlePrice18);
        console2.log("deltaBps (signed) :", ev.deltaBps);
        console2.log("winningSide (1=UP,2=DOWN,3=RANGE) :", uint256(uint8(ev.winningSide)));

        _sweepToEnd(A, epochId);
        ev = A.getEpoch(epochId);
        console2.log("swept; potWETH :", ev.potWETH);
        console2.log("swept; potUSDC :", ev.potUSDC);

        A.finalizeSettle();
        console2.log("settled epoch :", epochId);
    }

    /// @dev Pay every winner of `epochId` on `winningSide`, then fold dust + return NFTs.
    function _logWinners(uint64 epochId, IFeeArena.Side winningSide) internal {
        IFeeArena.StakeView[] memory stakes = A.getStakesByEpoch(epochId);
        uint256 paidW;
        uint256 paidU;
        for (uint256 i = 0; i < stakes.length; ++i) {
            if (stakes[i].side == winningSide && stakes[i].contribution6 > 0) {
                IFeeArena.ClaimPreview memory pv = A.previewClaim(epochId, stakes[i].tokenId);
                A.claim(epochId, stakes[i].tokenId); // pays the owner regardless of caller
                paidW += pv.payWETH;
                paidU += pv.payUSDC;
            }
        }
        console2.log("winners paid total WETH :", paidW);
        console2.log("winners paid total USDC :", paidU);
        _maybeFoldDustAndUnstake(epochId, stakes);
    }

    function _maybeFoldDustAndUnstake(uint64 epochId, IFeeArena.StakeView[] memory stakes) internal {
        try A.foldDust(epochId) {
            console2.log("dust folded forward for epoch :", epochId);
        } catch {
            // nothing to fold (exact division) -- fine.
        }
        for (uint256 i = 0; i < stakes.length; ++i) {
            vm.prank(stakes[i].owner);
            A.unstake(stakes[i].tokenId);
        }
        console2.log("all NFTs unstaked for epoch :", epochId);
    }

    // ---- real V3 staking / swapping helpers ----

    /// @dev Mint a REAL full-range position to `lp` (funded + approved) and stake it on `side`.
    function _mintStake(address lp, IFeeArena.Side side) internal returns (uint256 tokenId) {
        tokenId = _mintReal(lp, 5 ether, 15_000e6);
        vm.roll(block.number + 1); // one-action-per-block guard is per-address; advance anyway
        vm.prank(lp);
        v3.npm.safeTransferFrom(lp, address(A), tokenId, abi.encode(side));
    }

    function _mintReal(address lp, uint256 wethAmt, uint256 usdcAmt) internal returns (uint256 tokenId) {
        vm.deal(lp, wethAmt + 1 ether);
        vm.startPrank(lp);
        W.deposit{value: wethAmt}();
        vm.stopPrank();
        U.mint(lp, usdcAmt);
        vm.startPrank(lp);
        W.approve(address(v3.npm), type(uint256).max);
        U.approve(address(v3.npm), type(uint256).max);
        (tokenId,) = V3Deployer.mintPosition(v3, address(W), address(U), DEFAULT_FEE_TIER, lp, wethAmt, usdcAmt);
        vm.stopPrank();
    }

    /// @dev Run REAL swaps in BOTH directions so fees accrue on both the WETH and USDC legs
    ///      (a more complete demo than a single-direction swap).
    function _accrueRealFees(uint256 wethIn) internal {
        address trader = makeAddr("demoTrader");
        // leg 1: WETH -> USDC (accrues WETH-leg fees)
        vm.deal(trader, wethIn + 1 ether);
        vm.startPrank(trader);
        W.deposit{value: wethIn}();
        W.approve(address(v3.router), type(uint256).max);
        uint256 usdcOut = V3Deployer.swapExactInput(v3, address(W), address(U), DEFAULT_FEE_TIER, trader, wethIn);
        // leg 2: USDC -> WETH (accrues USDC-leg fees) using the USDC just received
        U.approve(address(v3.router), type(uint256).max);
        if (usdcOut > 0) {
            V3Deployer.swapExactInput(v3, address(U), address(W), DEFAULT_FEE_TIER, trader, usdcOut);
        }
        vm.stopPrank();
    }

    /// @dev sqrtPriceX96 for the SORTED pair at ~3000 USDC(6)/WETH(18).
    function _sqrtPriceForPair(address w, address u) internal pure returns (uint160) {
        uint256 num;
        uint256 den;
        if (u < w) {
            num = 1e18;
            den = 3000e6;
        } else {
            num = 3000e6;
            den = 1e18;
        }
        uint256 ratioX192 = (num << 192) / den;
        return uint160(_isqrt(ratioX192));
    }

    function _isqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
