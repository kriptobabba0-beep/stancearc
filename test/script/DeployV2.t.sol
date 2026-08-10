// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DeployV2} from "../../script/DeployV2.s.sol";
import {V3Deployer} from "../utils/V3Deployer.sol";
import {WETH9} from "../../src/mocks/WETH9.sol";
import {TestERC20} from "../../src/mocks/TestERC20.sol";
import {FeeArenaV2} from "../../src/FeeArenaV2.sol";
import {CreatePool} from "../../script/CreatePool.s.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Unit test for the DeployV2 script core: it wires FeeArenaV2 with the demo timings/band
///         AND the v2 conviction/oracle/treasury config via {FeeArenaV2.BootConfigV2}, against a
///         real V3 pool (so wethIsToken0 / WETH_NOTIONAL_DIV resolve on-chain).
contract DeployV2Test is Test {
    DeployV2 internal script;
    V3Deployer.V3 internal v3;
    CreatePool internal pools;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal weth;
    address internal usdc;
    address internal factory;
    address internal npm;
    address internal pool;
    uint24 internal constant FEE = 3000;

    function setUp() public {
        script = new DeployV2();
        pools = new CreatePool();
        weth = address(new WETH9());
        usdc = address(new TestERC20("USD Coin", "USDC", 6));
        v3 = V3Deployer.deploy(weth);
        factory = address(v3.factory);
        npm = address(v3.npm);
        uint160 sp = pools.encodeSqrtPrice(weth, usdc, 3000e18);
        pool = pools.createPool(factory, npm, weth, usdc, FEE, sp);
    }

    function _params() internal view returns (DeployV2.Params memory) {
        return DeployV2.Params({
            usdc: usdc,
            weth: weth,
            pool: pool,
            npm: npm,
            factory: factory,
            oracleOwner: owner,
            owner: owner,
            treasury: treasury,
            feeTier: FEE,
            minLiquidity: 1e6,
            seedPrice18: 3000e18
        });
    }

    function test_DeployV2_WiresArenaWithDemoTimingsAndV2Config() public {
        FeeArenaV2 arena = script.deployFeeArenaV2(_params());

        // core wiring
        assertEq(arena.USDC(), usdc, "usdc");
        assertEq(arena.WETH(), weth, "weth");
        assertEq(arena.POOL(), pool, "pool");
        assertEq(arena.NPM(), npm, "npm");
        assertEq(arena.FACTORY(), factory, "factory");
        assertEq(uint256(arena.FEE_TIER()), FEE, "feeTier");
        assertEq(arena.owner(), owner, "owner");

        // v2 oracle is the MUTABLE slot (C4-migratable), owned by the requested oracleOwner + seeded.
        assertEq(Ownable(arena.oracle()).owner(), owner, "oracle owner");

        // demo timings/band snapshotted into live config
        assertEq(uint256(arena.entryWindow()), uint256(arena.DEMO_ENTRY_WINDOW()), "entryWindow=2min");
        assertEq(uint256(arena.epochDuration()), uint256(arena.DEMO_EPOCH_DURATION()), "epochDuration=5min");
        assertEq(int256(arena.bandBps()), int256(arena.DEFAULT_BAND_BPS()), "band=150");

        // v2 conviction/oracle/treasury config (the BootConfigV2 additions)
        assertEq(arena.TREASURY(), treasury, "treasury");
        assertEq(arena.minConv(), script.DEFAULT_MIN_CONV(), "minConv");
        assertEq(arena.maxConv(), script.DEFAULT_MAX_CONV(), "maxConv");
        assertEq(uint256(arena.settleWindow()), uint256(script.DEFAULT_SETTLE_WINDOW()), "settleWindow");
        assertEq(uint256(arena.maxConfBps()), uint256(script.DEFAULT_MAX_CONF_BPS()), "maxConfBps");
        assertEq(uint256(arena.maxStakesPerEpoch()), uint256(script.DEFAULT_MAX_STAKES_EPOCH()), "maxStakesPerEpoch");
        assertEq(arena.maxSubsidyPerEpoch(), script.DEFAULT_MAX_SUBSIDY(), "maxSubsidyPerEpoch");

        // dust-gate holds at boot: maxSubsidyPerEpoch < 2*minConv
        assertLt(arena.maxSubsidyPerEpoch(), 2 * arena.minConv(), "dust-gate broken at deploy");
        // settleWindow within the hard cap
        assertLe(uint256(arena.settleWindow()), uint256(arena.MAX_SETTLE_WINDOW()), "settleWindow > hard cap");
        // maxConfBps strictly below the band
        assertLt(int256(uint256(arena.maxConfBps())), int256(arena.bandBps()), "conf not below band");

        // derived WETH_NOTIONAL_DIV (18+18-6) = 1e30; wethIsToken0 resolved from the real pool
        assertEq(arena.WETH_NOTIONAL_DIV(), 1e30, "notional div derived");
        assertEq(uint256(arena.wethIsToken0()), weth < usdc ? 1 : 0, "wethIsToken0 resolved");
    }
}
