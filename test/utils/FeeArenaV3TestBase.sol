// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArenaV3} from "src/FeeArenaV3.sol";
import {IFeeArenaV3} from "src/interfaces/IFeeArenaV3.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";

// Minimal pool/factory mocks (mirrors FeeArenaTestBase's; redeclared locally so the v3
// fixture is self-contained and the v1 base stays untouched).
contract MockPoolV3 {
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address t0, address t1, uint24 f) {
        token0 = t0;
        token1 = t1;
        fee = f;
    }
}

contract MockFactoryV3 {
    address public defaultPool;

    constructor(address p) {
        defaultPool = p;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return defaultPool;
    }
}

/// @notice Shared fixture for the ENTRY-ANCHORED FeeArenaV3 suite. Production-like token
///         decimals: 8-dp base (cirBTC mirror) + 6-dp USDC, so NOTIONAL_DIV == 1e20 and
///         the USD-notional contribution math is exercised at real scale. Band defaults to
///         the PDF's recommended ±1.5% (150 bps) so the document's worked examples
///         (100,000 entry / 101,500 threshold / 102,200 final) are testable verbatim.
contract FeeArenaV3TestBase is Test {
    FeeArenaV3 internal arena;
    MockPriceOracle internal oracle;
    TestERC20 internal base; // 8-dp cirBTC stand-in
    TestERC20 internal usdc; // 6-dp
    MockPoolV3 internal pool;
    MockFactoryV3 internal factory;
    MockNonfungiblePositionManager internal npm;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");

    uint24 internal constant FEE_TIER = 3000;
    uint128 internal constant MIN_LIQ = 1000;
    uint32 internal constant ENTRY_WINDOW = 300;
    uint32 internal constant LOCK_DURATION = 600;
    uint32 internal constant MAX_PRICE_AGE = 900;
    int32 internal constant BAND_BPS = 150; // the PDF's recommended +/-1.5%
    uint32 internal constant SETTLE_SANITY_BPS = 100; // final must sit within 1% of the Pyth anchor

    /// @dev 100,000 USD in 18-dp price scale — the PDF's running example anchor.
    uint256 internal constant P100K = 100_000e18;

    bytes[] internal NO_PRICE_DATA; // mock oracle ignores update payloads

    mapping(address => uint256) internal tokenIdByOwner;

    function setUp() public virtual {
        vm.warp(1_000_000);
        vm.roll(100);

        base = new TestERC20("Circle BTC", "cirBTC", 8);
        usdc = new TestERC20("USD Coin", "USDC", 6);
        oracle = new MockPriceOracle(); // this test contract owns it (setPrice direct)

        pool = new MockPoolV3(address(base), address(usdc), FEE_TIER);
        factory = new MockFactoryV3(address(pool));
        npm = new MockNonfungiblePositionManager(address(factory), address(pool));

        arena = new FeeArenaV3(_bootConfig());
    }

    function _bootConfig() internal view returns (IFeeArenaV3.BootConfig memory) {
        return IFeeArenaV3.BootConfig({
            usdc: address(usdc),
            base: address(base),
            pool: address(pool),
            npm: address(npm),
            factory: address(factory),
            oracle: address(oracle),
            owner: owner,
            feeTier: FEE_TIER,
            minLiquidity: MIN_LIQ,
            entryWindow: ENTRY_WINDOW,
            lockDuration: LOCK_DURATION,
            maxPriceAge: MAX_PRICE_AGE,
            bandBps: BAND_BPS,
            settleSanityBps: SETTLE_SANITY_BPS
        });
    }

    // ---- lifecycle helpers ----

    function _openEpoch() internal returns (uint64 id) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
    }

    /// @dev Mint a position to `lp` and stake it at the CURRENT oracle price (the caller
    ///      sets the price first via `_setPrice`). expected == actual -> zero deviation.
    function _stake(address lp, IFeeArenaV3.Side side) internal returns (uint256 tokenId) {
        (uint256 price18,) = oracle.getPrice();
        tokenId = _stakeExpecting(lp, side, price18, 50);
    }

    /// @dev Set the oracle to `price18` then stake — the per-position entry anchor.
    function _stakeAt(address lp, IFeeArenaV3.Side side, uint256 price18) internal returns (uint256 tokenId) {
        _setPrice(price18);
        tokenId = _stakeExpecting(lp, side, price18, 50);
    }

    function _stakeExpecting(address lp, IFeeArenaV3.Side side, uint256 expected, uint256 maxDevBps)
        internal
        returns (uint256 tokenId)
    {
        tokenId = npm.mintTo(lp, address(base), address(usdc), FEE_TIER, MIN_LIQ);
        vm.roll(block.number + 1); // one-action-per-block guard across stakers
        vm.prank(lp);
        arena.stakeWithSide(tokenId, side, expected, maxDevBps, NO_PRICE_DATA);
        tokenIdByOwner[lp] = tokenId;
    }

    function _setPrice(uint256 price18) internal {
        oracle.setPrice(price18);
    }

    /// @dev Program the fees `collect()` will yield at processing AND mirror them into the
    ///      arena vault (the mock collect moves no tokens; production lands them via NPM).
    function _programOwed(uint256 tokenId, uint256 owedBase, uint256 owedUsdc) internal {
        if (arena.baseIsToken0() == 1) {
            npm.setOwed(tokenId, uint128(owedBase), uint128(owedUsdc));
        } else {
            npm.setOwed(tokenId, uint128(owedUsdc), uint128(owedBase));
        }
        if (owedBase > 0) base.mint(address(arena), owedBase);
        if (owedUsdc > 0) usdc.mint(address(arena), owedUsdc);
    }

    /// @dev Warp to the settlement moment and submit `finalPrice18` with the anchor set to
    ///      the SAME value (zero sanity deviation). Sample window = the last 60 seconds.
    function _settleAt(uint256 finalPrice18) internal {
        uint64 id = arena.currentEpochId();
        IFeeArenaV3.EpochView memory e = arena.getEpoch(id);
        vm.warp(e.settlementTime);
        _setPrice(finalPrice18); // anchor (updatedAt == settlementTime)
        vm.prank(owner);
        arena.submitSettlementPrice(
            id, finalPrice18, e.settlementTime - 60, e.settlementTime, keccak256("samples"), NO_PRICE_DATA
        );
    }

    function _processAll() internal {
        arena.processPositions(arena.currentEpochId(), 50);
    }

    function _finalize() internal {
        arena.finalizeEpoch(arena.currentEpochId());
    }

    /// @dev Full happy-path drive: settle at `finalPrice18`, process everything, finalize.
    function _settleProcessFinalize(uint256 finalPrice18) internal {
        _settleAt(finalPrice18);
        _processAll();
        _finalize();
    }

    function _tokenIdOf(address lp) internal view returns (uint256) {
        return tokenIdByOwner[lp];
    }
}
