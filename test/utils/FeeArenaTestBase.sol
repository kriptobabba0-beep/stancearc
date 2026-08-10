// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {WETH9} from "src/mocks/WETH9.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";
import {V3Deployer} from "test/utils/V3Deployer.sol";

// Minimal mock pool: only token0/token1/fee needed by FeeArena init (wethIsToken0 resolution).
contract MockPool {
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address t0, address t1, uint24 f) {
        token0 = t0;
        token1 = t1;
        fee = f;
    }
}

// Token-pair-aware mock factory: getPool(t0,t1,fee) -> configured pool (default = POOL).
// Used by FeeArena init (immutable store) and by the stake-time pool validation (K7).
contract MockFactory {
    mapping(bytes32 => address) internal _pool;
    address public defaultPool;

    constructor(address p) {
        defaultPool = p;
    }

    function setDefaultPool(address p) external {
        defaultPool = p;
    }

    function setPool(address t0, address t1, uint24 fee, address p) external {
        _pool[keccak256(abi.encode(t0, t1, fee))] = p;
    }

    function getPool(address t0, address t1, uint24 fee) external view returns (address) {
        address p = _pool[keccak256(abi.encode(t0, t1, fee))];
        return p == address(0) ? defaultPool : p;
    }
}

contract FeeArenaTestBase is Test {
    FeeArena internal arena;
    MockPriceOracle internal oracle;
    WETH9 internal weth;
    TestERC20 internal usdc; // 6-decimal stand-in for ERC-20 USDC @ 0x3600...
    MockPool internal pool;
    MockFactory internal factory;
    MockNonfungiblePositionManager internal npm;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");

    uint24 internal constant FEE_TIER = 3000;
    uint128 internal constant MIN_LIQ = 1000;
    uint128 internal constant MIN_LIQUIDITY = MIN_LIQ; // alias used by stake tests

    // Uniform tickSpan of a default-minted mock position. contribution6 of an in-range
    // position == liquidity * DEFAULT_TICK_SPAN. The span is uniform across all
    // default-minted positions, so it CANCELS in the per-side payout ratios — only the
    // absolute contribution6 / sideContribution6 / winnerDenominator values scale by it.
    uint32 internal constant DEFAULT_TICK_SPAN = 12000;

    // demo timing (spec Decisions): 2min entry / 5min epoch, 30s gap, 10min delay/age
    uint32 internal constant ENTRY_WINDOW = 120;
    uint32 internal constant EPOCH_DURATION = 300;
    uint32 internal constant MIN_START_GAP = 30;
    uint32 internal constant MAX_START_DELAY = 600;
    uint32 internal constant MAX_PRICE_AGE = 600;
    int32 internal constant BAND_BPS = 150;

    function setUp() public virtual {
        _deployArenaSystem();
    }

    /// @dev Deploy the full Fee Arena fixture (tokens, oracle, pool/factory/NPM, FeeArena).
    ///      Extracted from `setUp` so the invariant suites can call it from their own
    ///      `setUp` override before wiring the fuzzing handler. The deploying contract
    ///      (the test/suite) is the oracle owner; transfer it to the handler if the
    ///      handler must set prices (see the invariant suites).
    function _deployArenaSystem() internal {
        vm.warp(1_000_000); // start from a non-zero, stable timestamp
        vm.roll(100); // non-zero block number for same-block guards

        weth = new WETH9();
        usdc = new TestERC20("USD Coin", "USDC", 6);
        // MockPriceOracle uses a no-arg constructor; the deployer (this test
        // contract) is the oracle owner, so _setOraclePrice calls setPrice directly.
        oracle = new MockPriceOracle();

        pool = new MockPool(address(weth), address(usdc), FEE_TIER);
        factory = new MockFactory(address(pool));
        npm = new MockNonfungiblePositionManager(address(factory), address(pool));

        arena = new FeeArena(_bootConfig());
    }

    /// @dev Default boot config used by setUp. Tests that exercise constructor
    ///      reverts copy this and mutate one field (see _bootConfig overloads).
    function _bootConfig() internal view returns (IFeeArena.BootConfig memory) {
        return IFeeArena.BootConfig({
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
            bandBps: BAND_BPS
        });
    }

    // ---- helpers reused by later tasks/groups ----
    function _setOraclePrice(uint256 price18) internal {
        // This test contract is the oracle owner (it deployed it), so call directly.
        oracle.setPrice(price18);
    }

    /// @dev Create epoch #1 and flip it to EntryOpen (staking window). Stake test
    ///      contracts call this from their own setUp override after super.setUp(),
    ///      so the lifecycle tests (which expect a pristine, epoch-free state) stay
    ///      unaffected.
    function _openEntryEpoch() internal returns (uint64 id) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
    }

    /// @dev mint a position OWNED BY `lp` on the Arena pool's token pair, ready to stake.
    ///      Uses the mock's DEFAULT symmetric range (uniform tickSpan == DEFAULT_TICK_SPAN).
    function _mintPosition(address lp, uint128 liquidity) internal returns (uint256 id) {
        // ordering matches pool token0/token1; WETH/USDC addresses fixed at deploy.
        id = npm.mintTo(lp, address(weth), address(usdc), FEE_TIER, liquidity);
    }

    /// @dev mint a position with an EXPLICIT tick range so a test can pin a custom
    ///      tickSpan (= tickUpper - tickLower) for the range-normalization test.
    function _mintPositionWithRange(address lp, uint128 liquidity, int24 tickLower, int24 tickUpper)
        internal
        returns (uint256 id)
    {
        id = npm.mintToWithRange(lp, address(weth), address(usdc), FEE_TIER, liquidity, tickLower, tickUpper);
    }

    /// @dev Drive the CURRENT epoch from EntryOpen -> Running -> Resolved, then FORCE
    ///      it to Settled with the supplied positions marked `swept`. Group M
    ///      (sweep/finalizeSettle) is not built yet, so the Settled/swept transition
    ///      is forced via vm.store rather than by calling M's cranks. This keeps
    ///      Component K self-contained without re-implementing M's canonical functions.
    function _settleEpochTo(uint256 settlePrice18, uint256[] memory sweptTokenIds) internal {
        uint64 id = arena.currentEpochId();
        IFeeArena.EpochView memory e = arena.getEpoch(id);

        // start (EntryOpen -> Running)
        vm.warp(e.entryCloseTime + MIN_START_GAP);
        _setOraclePrice(settlePrice18);
        arena.startEpoch(new bytes[](0));

        // end (Running -> Resolved)
        IFeeArena.EpochView memory e2 = arena.getEpoch(id);
        vm.warp(e2.endTime);
        _setOraclePrice(settlePrice18);
        bytes[] memory empty = new bytes[](0);
        arena.endEpoch{value: 0}(empty);

        // force Settled + per-position swept (M not built)
        _forceSettled(id);
        for (uint256 i = 0; i < sweptTokenIds.length; i++) {
            _forceSwept(sweptTokenIds[i]);
        }
    }

    /// @dev convenience overload for a single staked tokenId.
    function _settleEpochTo(uint256 settlePrice18, uint256 sweptTokenId) internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = sweptTokenId;
        _settleEpochTo(settlePrice18, ids);
    }

    /// @dev Force epoch `id` to Phase.Settled by writing the packed phase byte.
    function _forceSettled(uint64 id) internal {
        bytes32 rowBase = keccak256(abi.encode(uint256(id), EPOCHS_SLOT));
        // Epoch.phase (enum) is the first field => low byte of the row's first slot.
        // Settled == 5 (None,EntryOpen,Running,Resolved,Swept,Settled).
        bytes32 cur = vm.load(address(arena), rowBase);
        bytes32 cleared = bytes32(uint256(cur) & ~uint256(0xff));
        vm.store(address(arena), rowBase, bytes32(uint256(cleared) | uint256(5)));
    }

    /// @dev Set Position.swept = true for `tokenId` by writing storage directly.
    function _forceSwept(uint256 tokenId) internal {
        bytes32 rowBase = keccak256(abi.encode(uint256(tokenId), POSITIONS_SLOT));
        // Position slot0 packs {owner(20),epochId(8),side(1),swept(1),claimed(1),
        // unstaked(1)}. swept is at byte offset owner(20)+epochId(8)+side(1) = 29.
        bytes32 cur = vm.load(address(arena), rowBase);
        bytes32 withSwept = bytes32(uint256(cur) | (uint256(1) << (29 * 8)));
        vm.store(address(arena), rowBase, withSwept);
    }

    // Slot indices resolved from the L1 declaration order in FeeArena.sol; verified
    // by StakeStorageSlotTest so a future layout change fails loudly rather than
    // silently corrupting these helpers.
    uint256 internal constant EPOCHS_SLOT = 3;
    uint256 internal constant POSITIONS_SLOT = 4;

    /// @dev Read the Epoch fields NOT projected by `getEpoch()`'s EpochView, namely the
    ///      running `claimedWETH`/`claimedUSDC` counters and the `rolloverConsumed` guard.
    ///      The `epochs` mapping is `internal`, so this reads them directly out of storage
    ///      via the same EPOCHS_SLOT base used by `_forceSettled`. Offsets follow the packed
    ///      `struct Epoch` layout (verified by `test_EpochRawOffsets_AreCorrect`):
    ///        +0 {phase,entryOpen,entryClose,start}      +1 {end,startActual,settleActual,
    ///        winningSide,rolledOver,rolloverConsumed,sweepCursor}  +2 {stakedCount,bandBps}
    ///        +3 startPrice  +4 settlePrice  +5 deltaBps  +6 potWETH  +7 potUSDC
    ///        +8..11 sideContribution6[4]  +12 winnerDenominator
    ///        +13 claimedWETH  +14 claimedUSDC  +15 claimedCount
    function _epochRaw(uint64 id)
        internal
        view
        returns (uint256 claimedWETH, uint256 claimedUSDC, bool rolloverConsumed)
    {
        bytes32 rowBase = keccak256(abi.encode(uint256(id), EPOCHS_SLOT));
        claimedWETH = uint256(vm.load(address(arena), bytes32(uint256(rowBase) + 13)));
        claimedUSDC = uint256(vm.load(address(arena), bytes32(uint256(rowBase) + 14)));
        // rolloverConsumed lives in slot +1 at byte offset 26 (after end(8)+startActual(8)
        // +settleActual(8)+winningSide(1)+rolledOver(1)).
        bytes32 slot1 = vm.load(address(arena), bytes32(uint256(rowBase) + 1));
        rolloverConsumed = (uint256(slot1) >> (26 * 8)) & 0xff != 0;
    }

    function _createOpenStart(uint256 startPrice18) internal returns (uint64 id) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        vm.warp(e.entryCloseTime + MIN_START_GAP); // now >= entryCloseTime, within maxStartDelay
        _setOraclePrice(startPrice18);
        arena.startEpoch(new bytes[](0));
    }

    // =====================================================================
    // Group M (sweep / settle / claim / rollover / emergency) helpers.
    // These ADD to the base; they do not change any K/L behaviour.
    // =====================================================================

    /// @dev Default start price for the current epoch when driven by the M helpers
    ///      (the spec worked example uses 3000e18 start, 3060e18 settle).
    uint256 internal constant DEFAULT_START_PRICE = 3000e18;

    /// @dev tokenId most-recently staked by a given LP (set inside `_mintAndStake`).
    ///      Worked-example/claim tests use one position per LP, so last==only.
    mapping(address => uint256) internal tokenIdByOwner;

    /// @dev Deploy a fresh arena with a custom USDC token (M1 bad-decimals case).
    function _deployArenaWithUsdc(address usdc_) internal returns (FeeArena) {
        IFeeArena.BootConfig memory c = _bootConfig();
        c.usdc = usdc_;
        return new FeeArena(c);
    }

    /// @dev Deploy a fresh arena with a custom WETH token (M1 bad-decimals case).
    function _deployArenaWithWeth(address weth_) internal returns (FeeArena) {
        IFeeArena.BootConfig memory c = _bootConfig();
        c.weth = weth_;
        return new FeeArena(c);
    }

    /// @dev Mint a V3 position for `lp`, stake it on `side`, record its tokenId.
    ///      Must be called while the current epoch is in EntryOpen (staking window).
    function _mintAndStake(address lp, IFeeArena.Side side) internal returns (uint256 tokenId) {
        tokenId = _mintPosition(lp, MIN_LIQUIDITY);
        vm.roll(block.number + 1); // satisfy one-action-per-block guard across multiple stakers
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(side));
        tokenIdByOwner[lp] = tokenId;
    }

    /// @dev Mint + stake + program the fees `collect()` will yield at sweep time.
    function _stakeOwed(address lp, IFeeArena.Side side, uint256 owedWeth, uint256 owedUsdc)
        internal
        returns (uint256 tokenId)
    {
        tokenId = _mintAndStake(lp, side);
        _programOwed(tokenId, owedWeth, owedUsdc);
    }

    /// @dev Program the NPM mock's `collect()` return ordered by the pool's token layout
    ///      (WETH leg / USDC leg), regardless of which is token0. ALSO mirrors those fees
    ///      into the arena vault: the MockNPM.collect() does not actually move tokens, so we
    ///      realize the owed fees into the vault here (production: sweep's collect transfers
    ///      them). This keeps accounted pot == realized balance, so the solvency invariant
    ///      asserted inside sweep/finalize/claim holds without per-test funding.
    function _programOwed(uint256 tokenId, uint256 owedWeth, uint256 owedUsdc) internal {
        if (arena.wethIsToken0() == 1) {
            npm.setOwed(tokenId, uint128(owedWeth), uint128(owedUsdc));
        } else {
            npm.setOwed(tokenId, uint128(owedUsdc), uint128(owedWeth));
        }
        _fundVault(owedWeth, owedUsdc);
    }

    /// @dev `_addStake` alias from the plan: mint+stake another LP with owed fees.
    function _addStake(address lp, IFeeArena.Side side, uint256 owedWeth, uint256 owedUsdc)
        internal
        returns (uint256 tokenId)
    {
        tokenId = _stakeOwed(lp, side, owedWeth, owedUsdc);
    }

    /// @dev Create epoch, open entry, stake one LP, then drive to Running.
    function _openRunningEpochWith(address lp, IFeeArena.Side side, uint256 owedWeth, uint256 owedUsdc)
        internal
        returns (uint64 id)
    {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lp, side, owedWeth, owedUsdc);
        _warpToEntryClose();
        _setOraclePrice(DEFAULT_START_PRICE);
        arena.startEpoch(new bytes[](0));
    }

    /// @dev Default Running-epoch fixture (one UP staker, 1 WETH + 2000 USDC owed).
    function _openRunningEpoch() internal returns (uint64 id) {
        return _openRunningEpochWith(makeAddr("lp0"), IFeeArena.Side.UP, 1e18, 2000e6);
    }

    /// @dev Warp to entryClose and start the current epoch at an explicit start price.
    ///      Lets the worked example use a low start (so a 3000e18 settle is a clean UP win
    ///      while the contribution is valued at exactly 3000).
    function _startCurrentAt(uint256 startPrice18) internal {
        _warpToEntryClose();
        _setOraclePrice(startPrice18);
        arena.startEpoch(new bytes[](0));
    }

    /// @dev End the current Running epoch at `price18` -> Resolved.
    function _endEpochAtPrice(uint256 price18) internal {
        _warpToEnd();
        _setOraclePrice(price18);
        bytes[] memory empty = new bytes[](0);
        arena.endEpoch{value: 0}(empty);
    }

    /// @dev Warp to >= entryClose (within maxStartDelay) so startEpoch is eligible.
    function _warpToEntryClose() internal {
        IFeeArena.EpochView memory e = arena.currentEpoch();
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
    }

    /// @dev Warp to the current epoch's endTime so endEpoch is eligible.
    function _warpToEnd() internal {
        IFeeArena.EpochView memory e = arena.currentEpoch();
        vm.warp(uint256(e.endTime));
    }

    /// @dev Thin warp wrapper (emergency tests).
    function _warpPast(uint256 ts) internal {
        vm.warp(ts);
    }

    /// @dev Mark the NPM mock's collect() to revert for this LP's position (try/catch test).
    function _makeCollectRevertFor(address lp) internal {
        npm.setCollectReverts(tokenIdByOwner[lp], true);
    }

    function _tokenIdOf(address lp) internal view returns (uint256) {
        return tokenIdByOwner[lp];
    }

    /// @dev Current epoch view (plan calls this `_epoch()`).
    function _epoch() internal view returns (IFeeArena.EpochView memory) {
        return arena.currentEpoch();
    }

    /// @dev Move the realized pot tokens into the vault so claim()'s ERC-20 transfers
    ///      succeed. The MockNPM.collect() does not actually move tokens, so we mirror
    ///      the accounted pot here (production: tokens land via NPM.collect).
    function _fundVault(uint256 wethAmt, uint256 usdcAmt) internal {
        if (wethAmt > 0) {
            vm.deal(address(this), address(this).balance + wethAmt);
            weth.deposit{value: wethAmt}();
            weth.transfer(address(arena), wethAmt);
        }
        if (usdcAmt > 0) {
            usdc.mint(address(arena), usdcAmt);
        }
    }

    /// @dev Re-deploy the pool/factory/NPM/arena so the pool reports WETH as token0
    ///      (wethFirst==true) or token1 (false). `wethIsToken0` is re-resolved from the
    ///      new POOL.token0() at construction. `_programOwed` keeps collect() ordering
    ///      consistent with the new layout automatically.
    function _setPoolTokenOrder(bool wethFirst) internal {
        address t0 = wethFirst ? address(weth) : address(usdc);
        address t1 = wethFirst ? address(usdc) : address(weth);
        pool = new MockPool(t0, t1, FEE_TIER);
        factory = new MockFactory(address(pool));
        npm = new MockNonfungiblePositionManager(address(factory), address(pool));
        arena = new FeeArena(_bootConfig());
    }

    /// @dev Settle an empty-winner epoch that rolls `wethRollover`+`usdcRollover` into
    ///      the global rollover (everyone DOWN; UP forced to win with no UP stakers).
    function _settleEmptyWinnerEpoch(uint256 usdcRollover, uint256 wethRollover) internal {
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        address d = makeAddr("ewDown");
        _stakeOwed(d, IFeeArena.Side.DOWN, wethRollover, usdcRollover);
        _warpToEntryClose();
        _setOraclePrice(DEFAULT_START_PRICE);
        arena.startEpoch(new bytes[](0));
        _endEpochAtPrice(3300e18); // +10% -> UP wins; no UP stakers -> empty winner
        arena.sweep(10);
        arena.finalizeSettle(); // rolls whole pot into rolloverWETH/USDC
    }

    // =====================================================================
    // Real-V3 fork fixture (used by test/fork/*). Reuses the existing
    // weth/usdc/oracle/arena/owner members and DEMO/DEFAULT constants; only
    // adds the V3 handles and the real-position helpers. The unit-mock setUp
    // path above is untouched — fork tests do NOT call setUp(); they call
    // _deployWithRealV3() directly.
    // =====================================================================

    V3Deployer.V3 internal v3;
    address internal forkPool;
    uint24 internal constant ARENA_FEE_TIER = FEE_TIER; // 3000
    uint128 internal constant ARENA_MIN_LIQUIDITY = MIN_LIQ; // 1000
    uint160 internal forkSqrtPrice;
    uint256 internal constant FORK_START_PRICE = 3000e18;

    /// @dev Deploys WETH9 + TestERC20(USDC,6) + the real =0.7.6 V3 fork + a real
    ///      WETH/USDC pool + MockPriceOracle + FeeArena over all of it. The
    ///      deploying test contract owns the oracle (so _setOraclePrice works), and
    ///      `owner` owns FeeArena. Stable warp/roll so same-block + staleness guards
    ///      have headroom.
    function _deployWithRealV3() internal {
        vm.warp(1_000_000);
        vm.roll(100);

        weth = new WETH9();
        usdc = new TestERC20("USD Coin", "USDC", 6);
        v3 = V3Deployer.deploy(address(weth));

        forkSqrtPrice = _forkSqrtPrice();
        forkPool = V3Deployer.createAndInitPool(v3, address(weth), address(usdc), ARENA_FEE_TIER, forkSqrtPrice);

        oracle = new MockPriceOracle(); // this test contract is the oracle owner
        _setOraclePrice(FORK_START_PRICE);

        arena = new FeeArena(_forkBootConfig());
    }

    /// @dev Boot config bound to the REAL V3 fork (pool/npm/factory) + real oracle.
    function _forkBootConfig() internal view returns (IFeeArena.BootConfig memory) {
        return IFeeArena.BootConfig({
            usdc: address(usdc),
            weth: address(weth),
            pool: forkPool,
            npm: address(v3.npm),
            factory: address(v3.factory),
            oracle: address(oracle),
            owner: owner,
            feeTier: ARENA_FEE_TIER,
            minLiquidity: ARENA_MIN_LIQUIDITY,
            entryWindow: ENTRY_WINDOW,
            epochDuration: EPOCH_DURATION,
            minStartGap: MIN_START_GAP,
            maxStartDelay: MAX_START_DELAY,
            maxPriceAge: MAX_PRICE_AGE,
            bandBps: BAND_BPS
        });
    }

    /// @dev sqrtPriceX96 for the SORTED pair at ~3000 USDC(6)/WETH(18), correct for
    ///      whichever token sorts first among the freshly-deployed addresses.
    function _forkSqrtPrice() internal view returns (uint160) {
        uint256 num;
        uint256 den;
        if (address(usdc) < address(weth)) {
            num = 1e18; // token0=USDC(6), token1=WETH(18): price = 1e18 / 3000e6
            den = 3000e6;
        } else {
            num = 3000e6; // token0=WETH(18), token1=USDC(6): price = 3000e6 / 1e18
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

    /// @dev Mint a REAL position to `lp` and return its tokenId. `lp` is funded with
    ///      WETH (wrapped from ETH) + minted USDC and approves the NPM here.
    function _mintRealPosition(address lp, uint256 wethAmt, uint256 usdcAmt) internal returns (uint256 tokenId) {
        vm.deal(lp, wethAmt + 1 ether);
        vm.startPrank(lp);
        weth.deposit{value: wethAmt}();
        vm.stopPrank();
        usdc.mint(lp, usdcAmt);
        vm.startPrank(lp);
        weth.approve(address(v3.npm), type(uint256).max);
        usdc.approve(address(v3.npm), type(uint256).max);
        (tokenId,) = V3Deployer.mintPosition(v3, address(weth), address(usdc), ARENA_FEE_TIER, lp, wethAmt, usdcAmt);
        vm.stopPrank();
    }

    /// @dev A trader runs a REAL swap to accrue fees on the fork pool.
    function _accrueFees(uint256 wethIn) internal {
        address trader = makeAddr("forkTrader");
        vm.deal(trader, wethIn + 1 ether);
        vm.startPrank(trader);
        weth.deposit{value: wethIn}();
        weth.approve(address(v3.router), type(uint256).max);
        V3Deployer.swapExactInput(v3, address(weth), address(usdc), ARENA_FEE_TIER, trader, wethIn);
        vm.stopPrank();
    }
}
