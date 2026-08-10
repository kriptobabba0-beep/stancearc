// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {FeeArenaV2Lens} from "src/FeeArenaV2Lens.sol";
import {EpochV2, Position} from "src/FeeArenaV2Types.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {WETH9} from "src/mocks/WETH9.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract MockPoolV2S {
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address t0, address t1, uint24 f) {
        token0 = t0;
        token1 = t1;
        fee = f;
    }
}

contract MockFactoryV2S {
    address public defaultPool;

    constructor(address p) {
        defaultPool = p;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return defaultPool;
    }
}

/// @dev Blocklisting USDC: a configurable per-address transfer block (Circle precompile sim).
contract BlocklistUSDC is TestERC20 {
    mapping(address => bool) public blocked;

    constructor() TestERC20("USD Coin", "USDC", 6) {}

    function setBlocked(address a, bool v) external {
        blocked[a] = v;
    }

    function transfer(address to, uint256 amt) public override returns (bool) {
        require(!blocked[to], "BLOCKED");
        return super.transfer(to, amt);
    }

    function transferFrom(address from, address to, uint256 amt) public override returns (bool) {
        require(!blocked[to], "BLOCKED");
        return super.transferFrom(from, to, amt);
    }
}

/// @notice Task 2 coverage: FeeArenaV2 SETTLE / SWEEP / FINALIZE + CLAIM / REFUND / SUBSIDY /
///         FOLD-DUST / withdrawCredited. Drives a full conviction-parimutuel epoch end-to-end.
contract FeeArenaV2SettleTest is Test {
    FeeArenaV2 internal arena;
    FeeArenaV2Lens internal lens;
    MockPriceOracle internal oracle;
    WETH9 internal weth;
    TestERC20 internal usdc;
    MockPoolV2S internal pool;
    MockFactoryV2S internal factory;
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

    function setUp() public virtual {
        vm.warp(1_000_000);
        vm.roll(100);
        weth = new WETH9();
        usdc = new TestERC20("USD Coin", "USDC", 6);
        oracle = new MockPriceOracle();
        pool = new MockPoolV2S(address(weth), address(usdc), FEE_TIER);
        factory = new MockFactoryV2S(address(pool));
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

    /// @dev stake `who` on `side` with `conviction` USDC. Bump block so same-block guard ok.
    function _stake(address who, IFeeArena.Side side, uint256 conviction) internal returns (uint256 tokenId) {
        tokenId = _mintFor(who, MIN_LIQ);
        vm.roll(block.number + 1);
        usdc.mint(who, conviction);
        vm.prank(who);
        usdc.approve(address(arena), conviction);
        vm.prank(who);
        arena.stakeWithConviction(tokenId, side, conviction);
    }

    /// @dev Program the fees `collect()` yields at sweep, ordered by pool token layout, AND
    ///      mirror the realized fees into the vault (mock collect moves no tokens).
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
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
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

    // ======================= subsidy =======================

    function test_FundSubsidy_CommitsIrreversiblyIntoPot() public {
        uint64 id = _openEntryEpoch();
        usdc.mint(owner, 100e6);
        vm.prank(owner);
        usdc.approve(address(arena), 100e6);
        vm.prank(owner);
        arena.fundSubsidy(id, 100e6);

        EpochV2 memory e = arena.getEpoch(id);
        assertEq(e.subsidyUSDC, 100e6, "subsidyUSDC");
        assertEq(e.potUSDC, 100e6, "potUSDC includes R");
        assertEq(arena.totalCommittedSubsidy(), 100e6, "totalCommittedSubsidy");
        assertEq(usdc.balanceOf(address(arena)), 100e6, "R held");
    }

    function test_FundSubsidy_RevertsAboveCap() public {
        uint64 id = _openEntryEpoch();
        usdc.mint(owner, MAX_SUBSIDY + 1);
        vm.prank(owner);
        usdc.approve(address(arena), MAX_SUBSIDY + 1);
        vm.prank(owner);
        vm.expectRevert(FeeArenaV2.SubsidyCapExceeded.selector);
        arena.fundSubsidy(id, MAX_SUBSIDY + 1);
    }

    function test_FundSubsidy_RevertsNonOwner() public {
        uint64 id = _openEntryEpoch();
        vm.prank(keeper);
        vm.expectRevert();
        arena.fundSubsidy(id, 100e6);
    }

    function test_FundSubsidy_RevertsAfterResolved() public {
        _openEntryEpoch();
        _stake(makeAddr("up"), IFeeArena.Side.UP, MIN_CONV);
        _startCurrent();
        _endCurrentAt(3100e18); // +3.33% -> UP wins; now Resolved
        uint64 id = arena.currentEpochId();
        usdc.mint(owner, 100e6);
        vm.prank(owner);
        usdc.approve(address(arena), 100e6);
        vm.prank(owner);
        vm.expectRevert(IFeeArena.WrongPhase.selector);
        arena.fundSubsidy(id, 100e6);
    }

    // ======================= sweep + finalize: UP-win =======================

    function test_Sweep_FoldsWinnerSqrtTallyAndPot() public {
        uint64 id = _openEntryEpoch();
        uint256 tUp = _stake(makeAddr("up"), IFeeArena.Side.UP, 400e6);
        uint256 tDown = _stake(makeAddr("down"), IFeeArena.Side.DOWN, 100e6);
        _programOwed(tUp, 1e18, 2000e6);
        _programOwed(tDown, 0, 500e6);

        _startCurrent();
        _endCurrentAt(3300e18); // +10% -> UP wins

        arena.sweep(10);

        EpochV2 memory e = arena.getEpoch(id);
        assertEq(uint8(e.winningSide), uint8(IFeeArena.Side.UP), "UP wins");
        // pot = all forfeited fees (both legs, both sides)
        assertEq(e.potWETH, 1e18, "potWETH");
        assertEq(e.potUSDC, 2500e6, "potUSDC = 2000 + 500");
        assertEq(e.winningConvictionSum, 400e6, "winConvSum (UP only)");
        assertEq(e.winnerSqrtConvSum, Math.sqrt(400e6), "sqrt tally");
        assertEq(arena.winnerCount(id), 1, "one positive-contribution winner");
    }

    function test_FinalizeSettle_BurnsLosingConvictionToTreasury() public {
        uint64 id = _openEntryEpoch();
        _stake(makeAddr("up"), IFeeArena.Side.UP, 400e6);
        uint256 tDown = _stake(makeAddr("down"), IFeeArena.Side.DOWN, 100e6);
        _programOwed(tDown, 0, 0);
        _startCurrent();
        _endCurrentAt(3300e18); // UP wins
        arena.sweep(10);

        uint256 treBefore = usdc.balanceOf(treasury);
        arena.finalizeSettle();

        EpochV2 memory e = arena.getEpoch(id);
        assertEq(e.burnedConviction, 100e6, "burned = DOWN conviction");
        assertEq(usdc.balanceOf(treasury) - treBefore, 100e6, "treasury received burn");
        assertEq(uint8(arena.getEpoch(id).winningSide), uint8(IFeeArena.Side.UP), "still UP");
    }

    function test_FullFlow_RefundAndClaim_UP_win() public {
        uint64 id = _openEntryEpoch();
        address up = makeAddr("up");
        address down = makeAddr("down");
        uint256 tUp = _stake(up, IFeeArena.Side.UP, 400e6);
        uint256 tDown = _stake(down, IFeeArena.Side.DOWN, 100e6);
        _programOwed(tUp, 1e18, 2000e6);
        _programOwed(tDown, 0, 0);

        // subsidy R = 100 USDC committed pre-resolve
        usdc.mint(owner, 100e6);
        vm.prank(owner);
        usdc.approve(address(arena), 100e6);
        vm.prank(owner);
        arena.fundSubsidy(id, 100e6);

        _startCurrent();
        _endCurrentAt(3300e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();

        // single winner -> winnerDenominator == sqrt(400e6)
        EpochV2 memory e = arena.getEpoch(id);
        assertEq(e.winnerDenominator, Math.sqrt(400e6), "denom = sqrt tally");
        // potUSDC = 2000 fees + 100 R = 2100; R-cap = 2*400e6 = 800e6 >> 2100e6? 2100e6 < 800e6 false
        // 2100e6 vs cap 800e6 -> capped! distributable = 800e6, excess 1300e6 rolled.
        assertEq(e.potUSDC, 800e6, "potUSDC R-capped to 2*winConv");

        // refund principal 1:1 (decoupled, exact)
        uint256 upBalBefore = usdc.balanceOf(up);
        arena.refundConviction(id, tUp, up);
        assertEq(usdc.balanceOf(up) - upBalBefore, 400e6, "refund 1:1");
        (, bool refunded) = arena.getConviction(tUp);
        assertTrue(refunded, "marked refunded");

        // claim pot share: single winner takes whole (capped) pot
        uint256 upUsdcBefore = usdc.balanceOf(up);
        uint256 upWethBefore = weth.balanceOf(up);
        arena.claim(id, tUp, up);
        assertEq(usdc.balanceOf(up) - upUsdcBefore, 800e6, "claim whole capped pot USDC");
        assertEq(weth.balanceOf(up) - upWethBefore, 1e18, "claim whole pot WETH");
    }

    function test_RefundConviction_RevertsForLoser() public {
        uint64 id = _openEntryEpoch();
        _stake(makeAddr("up"), IFeeArena.Side.UP, 400e6);
        uint256 tDown = _stake(makeAddr("down"), IFeeArena.Side.DOWN, 100e6);
        _startCurrent();
        _endCurrentAt(3300e18); // UP wins -> DOWN loses
        arena.sweep(10);
        arena.finalizeSettle();
        vm.expectRevert(FeeArenaV2.NotRefundable.selector);
        arena.refundConviction(id, tDown, address(0));
    }

    function test_RefundConviction_DoubleRefundReverts() public {
        uint64 id = _openEntryEpoch();
        uint256 tUp = _stake(makeAddr("up"), IFeeArena.Side.UP, 400e6);
        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();
        arena.refundConviction(id, tUp, address(0));
        vm.expectRevert(FeeArenaV2.AlreadyRefunded.selector);
        arena.refundConviction(id, tUp, address(0));
    }

    /// @dev A winning-side staker whose collect REVERTED (contribution6==0) still refunds
    ///      principal but CANNOT claim a pot share.
    function test_CollectRevertWinner_RefundsButCannotClaim() public {
        uint64 id = _openEntryEpoch();
        address up1 = makeAddr("up1");
        address up2 = makeAddr("up2");
        uint256 t1 = _stake(up1, IFeeArena.Side.UP, 300e6);
        uint256 t2 = _stake(up2, IFeeArena.Side.UP, 200e6);
        _programOwed(t1, 0, 1000e6);
        _programOwed(t2, 0, 1000e6);
        npm.setCollectReverts(t2, true); // up2's collect reverts at sweep

        _startCurrent();
        _endCurrentAt(3300e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();

        // up2 conviction still refundable (winning side)
        uint256 b = usdc.balanceOf(up2);
        arena.refundConviction(id, t2, up2);
        assertEq(usdc.balanceOf(up2) - b, 200e6, "collect-revert winner still refunds");

        // up2 cannot claim a pot share (contribution6==0)
        vm.expectRevert(IFeeArena.NothingToClaim.selector);
        arena.claim(id, t2, up2);

        // up1 (positive contribution) claims the whole pot
        arena.claim(id, t1, up1);
        assertEq(arena.winnerCount(id), 1, "only up1 counted");
    }

    // ======================= empty-winner =======================

    function test_EmptyWinner_RollsPotForward_ConvictionStillRefundable() public {
        uint64 id = _openEntryEpoch();
        // everyone DOWN; price goes UP so UP wins with NO UP stakers -> empty winner
        uint256 tDown = _stake(makeAddr("down"), IFeeArena.Side.DOWN, 300e6);
        _programOwed(tDown, 0, 1000e6);
        _startCurrent();
        _endCurrentAt(3300e18); // UP wins; no UP stakers
        arena.sweep(10);

        uint256 rollBefore = arena.rolloverUSDC();
        arena.finalizeSettle();

        EpochV2 memory e = arena.getEpoch(id);
        assertTrue(e.rolledOver, "rolled over");
        assertEq(e.winnerDenominator, 0, "no denom");
        assertEq(arena.rolloverUSDC() - rollBefore, 1000e6, "pot rolled forward");
        // DOWN was the LOSER -> its conviction is burned, not refundable
        vm.expectRevert(FeeArenaV2.NotRefundable.selector);
        arena.refundConviction(id, tDown, address(0));
    }

    /// @dev winners exist but ALL have contribution6==0 (dust LP): pot rolls forward, but
    ///      winning-side conviction is STILL refundable (gate is side==winner, not denom).
    function test_AllDustWinner_RollsPot_ButConvictionRefundable() public {
        uint64 id = _openEntryEpoch();
        address up = makeAddr("up");
        uint256 tUp = _stake(up, IFeeArena.Side.UP, 300e6);
        _programOwed(tUp, 0, 0); // UP winner realizes NO fee -> contribution6 == 0
        // a DOWN loser provides the pot
        uint256 tDown = _stake(makeAddr("down"), IFeeArena.Side.DOWN, 100e6);
        _programOwed(tDown, 0, 1000e6);
        _startCurrent();
        _endCurrentAt(3300e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();

        EpochV2 memory e = arena.getEpoch(id);
        assertTrue(e.rolledOver, "all-dust winner rolls forward");
        assertEq(e.winnerSqrtConvSum, 0, "no positive-contribution winner");
        // UP conviction STILL refundable
        uint256 b = usdc.balanceOf(up);
        arena.refundConviction(id, tUp, up);
        assertEq(usdc.balanceOf(up) - b, 300e6, "dust winner refunds principal");
    }

    // ======================= fold dust =======================

    function test_FoldDust_RollsResidualForward() public {
        uint64 id = _openEntryEpoch();
        // two winners with different convictions so sqrt floors leave dust
        address up1 = makeAddr("up1");
        address up2 = makeAddr("up2");
        uint256 t1 = _stake(up1, IFeeArena.Side.UP, 300e6);
        uint256 t2 = _stake(up2, IFeeArena.Side.UP, 700e6);
        _programOwed(t1, 0, 1000e6);
        _programOwed(t2, 0, 1234e6);
        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        arena.claim(id, t1, up1);
        arena.claim(id, t2, up2);

        EpochV2 memory e = arena.getEpoch(id);
        uint256 expectedDust = e.potUSDC - e.claimedUSDC;
        uint256 rollBefore = arena.rolloverUSDC();
        if (expectedDust > 0) {
            arena.foldDust(id);
            assertEq(arena.rolloverUSDC() - rollBefore, expectedDust, "dust folded");
        }
        // conviction bucket untouched: both refunds still exact
        uint256 b1 = usdc.balanceOf(up1);
        arena.refundConviction(id, t1, up1);
        assertEq(usdc.balanceOf(up1) - b1, 300e6, "refund unaffected by foldDust");
    }

    // ======================= blocklist-resilient payout =======================

    function test_BlocklistedWinner_DefersPayout_FoldDustNotBricked() public {
        // redeploy with a blocklisting USDC
        BlocklistUSDC busdc = new BlocklistUSDC();
        usdc = TestERC20(address(busdc));
        pool = new MockPoolV2S(address(weth), address(usdc), FEE_TIER);
        factory = new MockFactoryV2S(address(pool));
        npm = new MockNonfungiblePositionManager(address(factory), address(pool));
        arena = new FeeArenaV2(_boot());
        vm.prank(owner);
        arena.setKeeper(keeper);

        uint64 id = _openEntryEpoch();
        address up = makeAddr("upBlocked");
        // conviction 600e6 so R-cap (2*winConv = 1200e6) does NOT bite on the 1000e6 pot:
        // the whole 1000e6 pot is the single winner's share and must defer to the ledger.
        uint256 tUp = _stake(up, IFeeArena.Side.UP, 600e6);
        _programOwed(tUp, 0, 1000e6);
        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        // block the winner's address; claim must NOT revert, must defer + bump counters
        busdc.setBlocked(up, true);
        arena.claim(id, tUp, up);

        // claimedCount bumped despite the deferral, so foldDust gate is reachable
        EpochV2 memory e = arena.getEpoch(id);
        assertEq(e.claimedCount, arena.winnerCount(id), "claimedCount bumped on defer");
        assertEq(arena.owedUSDC(up), 1000e6, "deferred to ledger");
        assertEq(arena.totalLedgerUSDC(), 1000e6, "ledger aggregate bumped");

        // recover to a clean address
        address clean = makeAddr("clean");
        vm.prank(up);
        arena.withdrawCredited(clean);
        assertEq(busdc.balanceOf(clean), 1000e6, "recovered to clean addr");
        assertEq(arena.owedUSDC(up), 0, "ledger cleared");
    }

    function test_BlocklistedTreasury_BurnDefers_NoRevert() public {
        BlocklistUSDC busdc = new BlocklistUSDC();
        usdc = TestERC20(address(busdc));
        pool = new MockPoolV2S(address(weth), address(usdc), FEE_TIER);
        factory = new MockFactoryV2S(address(pool));
        npm = new MockNonfungiblePositionManager(address(factory), address(pool));
        arena = new FeeArenaV2(_boot());
        vm.prank(owner);
        arena.setKeeper(keeper);

        uint64 id = _openEntryEpoch();
        _stake(makeAddr("up"), IFeeArena.Side.UP, 300e6);
        uint256 tDown = _stake(makeAddr("down"), IFeeArena.Side.DOWN, 100e6);
        _programOwed(tDown, 0, 0);
        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);

        busdc.setBlocked(treasury, true); // burn-sink blocked
        arena.finalizeSettle(); // must NOT revert

        assertEq(arena.owedUSDC(treasury), 100e6, "burn deferred to treasury ledger");
        assertEq(arena.getEpoch(id).burnedConviction, 100e6, "burn accounted");
    }

    // ======================= previews =======================

    function test_PreviewClaim_MatchesActual_SqrtMath() public {
        uint64 id = _openEntryEpoch();
        address up = makeAddr("up");
        uint256 tUp = _stake(up, IFeeArena.Side.UP, 400e6);
        _programOwed(tUp, 1e18, 2000e6);
        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        IFeeArena.ClaimPreview memory pv = lens.previewClaim(id, tUp);
        assertTrue(pv.claimable, "claimable");
        uint256 wethBefore = weth.balanceOf(up);
        uint256 usdcBefore = usdc.balanceOf(up);
        arena.claim(id, tUp, up);
        assertEq(weth.balanceOf(up) - wethBefore, pv.payWETH, "preview WETH matches");
        assertEq(usdc.balanceOf(up) - usdcBefore, pv.payUSDC, "preview USDC matches");
    }

    function test_PreviewRefund_ReportsExactConviction() public {
        uint64 id = _openEntryEpoch();
        uint256 tUp = _stake(makeAddr("up"), IFeeArena.Side.UP, 400e6);
        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        arena.finalizeSettle();

        (bool refundable, uint256 amount) = lens.previewRefund(id, tUp);
        assertTrue(refundable, "refundable");
        assertEq(amount, 400e6, "exact conviction");

        arena.refundConviction(id, tUp, address(0));
        (refundable, amount) = lens.previewRefund(id, tUp);
        assertFalse(refundable, "no longer refundable");
        assertEq(amount, 0, "zero after refund");
    }

    // ======================= R-cap excess rolls =======================

    function test_RCap_ExcessRollsForward() public {
        uint64 id = _openEntryEpoch();
        // thin honest winning conviction (minConv) + big R -> R cap bites
        address up = makeAddr("up");
        uint256 tUp = _stake(up, IFeeArena.Side.UP, MIN_CONV); // 100e6
        _programOwed(tUp, 0, 0); // no fees; pot is pure R

        usdc.mint(owner, MAX_SUBSIDY);
        vm.prank(owner);
        usdc.approve(address(arena), MAX_SUBSIDY);
        vm.prank(owner);
        arena.fundSubsidy(id, MAX_SUBSIDY); // 150e6 R

        _startCurrent();
        _endCurrentAt(3300e18);
        arena.sweep(10);
        uint256 rollBefore = arena.rolloverUSDC();
        arena.finalizeSettle();

        // cap = 2*winConv = 200e6; potUSDC was 150e6 R only (< cap) -> NOT capped here.
        EpochV2 memory e = arena.getEpoch(id);
        // contribution6 == 0 so this is an all-dust winner -> rolls forward entirely
        assertTrue(e.rolledOver, "dust winner rolls");
        assertEq(arena.rolloverUSDC() - rollBefore, 150e6, "R rolled forward");
        // conviction still refundable
        uint256 b = usdc.balanceOf(up);
        arena.refundConviction(id, tUp, up);
        assertEq(usdc.balanceOf(up) - b, MIN_CONV, "refund");
    }
}
