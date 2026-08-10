// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {V3Deployer} from "../utils/V3Deployer.sol";
import {WETH9} from "../../src/mocks/WETH9.sol";
import {TestERC20} from "../../src/mocks/TestERC20.sol";
import {FeeArena} from "../../src/FeeArena.sol";
import {CreatePool} from "../../script/CreatePool.s.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract DeployTest is Test {
    Deploy internal script;
    V3Deployer.V3 internal v3;
    CreatePool internal pools;

    address internal owner = makeAddr("owner");
    address internal weth;
    address internal usdc;
    address internal factory;
    address internal npm;
    address internal pool;
    uint24 internal constant FEE = 3000;

    function setUp() public {
        script = new Deploy();
        pools = new CreatePool();
        weth = address(new WETH9());
        usdc = address(new TestERC20("USD Coin", "USDC", 6));
        v3 = V3Deployer.deploy(weth);
        factory = address(v3.factory);
        npm = address(v3.npm);
        uint160 sp = pools.encodeSqrtPrice(weth, usdc, 3000e18);
        pool = pools.createPool(factory, npm, weth, usdc, FEE, sp);
    }

    function test_Deploy_WiresFeeArenaWithDemoTimings() public {
        FeeArena arena = script.deployFeeArena(
            Deploy.Params({
                usdc: usdc,
                weth: weth,
                pool: pool,
                npm: npm,
                factory: factory,
                oracleOwner: owner,
                owner: owner,
                feeTier: FEE,
                minLiquidity: 1e6,
                seedPrice18: 3000e18
            })
        );

        assertEq(arena.USDC(), usdc, "usdc");
        assertEq(arena.WETH(), weth, "weth");
        assertEq(arena.POOL(), pool, "pool");
        assertEq(arena.NPM(), npm, "npm");
        assertEq(arena.FACTORY(), factory, "factory");
        assertEq(uint256(arena.FEE_TIER()), FEE, "feeTier");
        assertEq(uint256(arena.MIN_LIQUIDITY()), 1e6, "minLiq");
        assertEq(arena.owner(), owner, "owner");

        // oracle owned by the requested oracleOwner + seeded
        assertEq(Ownable(arena.ORACLE()).owner(), owner, "oracle owner");

        // demo timings snapshotted into live config (vs the core's published constants)
        assertEq(uint256(arena.entryWindow()), uint256(arena.DEMO_ENTRY_WINDOW()), "entryWindow=2min");
        assertEq(uint256(arena.epochDuration()), uint256(arena.DEMO_EPOCH_DURATION()), "epochDuration=5min");
        assertEq(uint256(arena.minStartGap()), uint256(arena.DEFAULT_MIN_START_GAP()), "minStartGap=30s");
        assertEq(uint256(arena.maxStartDelay()), uint256(arena.DEFAULT_MAX_START_DELAY()), "maxStartDelay=10min");
        assertEq(uint256(arena.maxPriceAge()), uint256(arena.DEFAULT_MAX_PRICE_AGE()), "maxPriceAge=10min");
        assertEq(int256(arena.bandBps()), int256(arena.DEFAULT_BAND_BPS()), "band=150");

        // WETH_NOTIONAL_DIV derived (18+18-6) = 1e30, NOT hardcoded
        assertEq(arena.WETH_NOTIONAL_DIV(), 1e30, "notional div derived");
        // wethIsToken0 resolved from the real pool
        assertEq(uint256(arena.wethIsToken0()), weth < usdc ? 1 : 0, "wethIsToken0 resolved");
    }
}
