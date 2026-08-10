// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {WETH9} from "src/mocks/WETH9.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";
import {FeeArenaV2Handler} from "test/invariant/handlers/FeeArenaV2Handler.sol";

contract MockPoolV2Inv {
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address t0, address t1, uint24 f) {
        token0 = t0;
        token1 = t1;
        fee = f;
    }
}

contract MockFactoryV2Inv {
    address public defaultPool;

    constructor(address p) {
        defaultPool = p;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return defaultPool;
    }
}

/// @notice Shared fixture for the FeeArenaV2 invariant suites. Deploys the arena system + the
///         v2 handler, hands the handler ownership of BOTH the arena (owner-gated cranks +
///         fundSubsidy) and the oracle (owner-gated setPrice/setConf), and restricts the fuzzer
///         to the handler's external action selectors. The TREASURY is a plain (non-blocked) EOA
///         so burned conviction is a real out-flow the conservation invariant can account for.
contract FeeArenaV2InvariantBase is Test {
    FeeArenaV2 internal arena;
    MockPriceOracle internal oracle;
    WETH9 internal weth;
    TestERC20 internal usdc;
    MockPoolV2Inv internal pool;
    MockFactoryV2Inv internal factory;
    MockNonfungiblePositionManager internal npm;
    FeeArenaV2Handler internal handler;

    address internal owner = makeAddr("v2InvOwner");
    address internal treasury = makeAddr("v2InvTreasury");

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
    uint256 internal constant MAX_SUBSIDY = 150e6; // < 2*minConv (dust-gate)

    function setUp() public virtual {
        vm.warp(1_000_000);
        vm.roll(100);

        weth = new WETH9();
        usdc = new TestERC20("USD Coin", "USDC", 6);
        oracle = new MockPriceOracle();
        pool = new MockPoolV2Inv(address(weth), address(usdc), FEE_TIER);
        factory = new MockFactoryV2Inv(address(pool));
        npm = new MockNonfungiblePositionManager(address(factory), address(pool));
        arena = new FeeArenaV2(_boot());

        handler = new FeeArenaV2Handler(
            arena,
            oracle,
            npm,
            address(weth),
            address(usdc),
            FEE_TIER,
            MIN_LIQ,
            MIN_CONV,
            MAX_CONV,
            MAX_SUBSIDY,
            MIN_START_GAP
        );

        // Hand the handler ownership of the arena (owner-gated createEpoch/openEntry/fundSubsidy)
        // and the oracle (owner-gated setPrice/setConf). Keeper stays unset so the handler's actor
        // EOAs are never blocked by operator-exclusion.
        vm.prank(owner);
        arena.transferOwnership(address(handler));
        oracle.transferOwnership(address(handler));

        bytes4[] memory sel = new bytes4[](8);
        sel[0] = handler.actStakeAndAdvance.selector;
        sel[1] = handler.actFundSubsidy.selector;
        sel[2] = handler.actEndAndResolve.selector;
        sel[3] = handler.actSweep.selector;
        sel[4] = handler.actFinalize.selector;
        sel[5] = handler.actClaim.selector;
        sel[6] = handler.actRefund.selector;
        sel[7] = handler.actFoldDust.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
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
}
