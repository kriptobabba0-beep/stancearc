// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {CreatePool, IUniswapV3PoolInit} from "../../script/CreatePool.s.sol";
import {V3Deployer} from "../utils/V3Deployer.sol";
import {WETH9} from "../../src/mocks/WETH9.sol";
import {TestERC20} from "../../src/mocks/TestERC20.sol";
import {IUniswapV3Factory} from "../../src/interfaces/IUniswapV3Factory.sol";

/// @dev Stands up a REAL =0.7.6 V3 factory + NPM + router via the V3Deployer library, then
///      drives the CreatePool script's helpers to create + init the WETH/USDC pool at the demo
///      fee tier. Asserts `factory.getPool` resolves to the created pool in BOTH orderings
///      (the validation path FeeArena relies on per spec §3.1 step 6) and that the helper is
///      idempotent. Also asserts the runtime-derived sqrtPriceX96 actually initialized the pool.
contract CreatePoolTest is Test {
    CreatePool internal script;
    V3Deployer.V3 internal v3;
    address internal factory;
    address internal npm;
    address internal weth;
    address internal usdc;
    uint24 internal constant FEE = 3000;

    function setUp() public {
        script = new CreatePool();
        weth = address(new WETH9());
        usdc = address(new TestERC20("USD Coin", "USDC", 6));
        v3 = V3Deployer.deploy(weth);
        factory = address(v3.factory);
        npm = address(v3.npm);
    }

    function test_CreatePool_CreatesAndInitsPool() public {
        // sqrtPriceX96 for ~1 WETH = 3000 USDC; derived at runtime from sorted addresses.
        uint160 sqrtPriceX96 = script.encodeSqrtPrice(weth, usdc, 3000e18);
        assertGt(sqrtPriceX96, 0, "encoded sqrt price nonzero");

        address pool = script.createPool(factory, npm, weth, usdc, FEE, sqrtPriceX96);

        assertTrue(pool != address(0), "pool created");
        // factory.getPool is order-independent; assert it resolves to our pool
        address fromFactory = IUniswapV3Factory(factory).getPool(weth, usdc, FEE);
        assertEq(fromFactory, pool, "factory.getPool == pool");
        assertEq(IUniswapV3Factory(factory).getPool(usdc, weth, FEE), pool, "reverse order");

        // pool was initialized to the derived sqrt price (slot0 unlocked + price matches)
        (uint160 onChainSqrt,,,,,, bool unlocked) = IUniswapV3PoolInit(pool).slot0();
        assertTrue(unlocked, "pool initialized");
        assertEq(onChainSqrt, sqrtPriceX96, "slot0 sqrtPrice == derived");
    }

    function test_CreatePool_Idempotent() public {
        uint160 sqrtPriceX96 = script.encodeSqrtPrice(weth, usdc, 3000e18);
        address p1 = script.createPool(factory, npm, weth, usdc, FEE, sqrtPriceX96);
        address p2 = script.createPool(factory, npm, weth, usdc, FEE, sqrtPriceX96);
        assertEq(p1, p2, "second call returns existing pool, no revert");
    }

    function test_EncodeSqrtPrice_OrderIndependent_NonZero() public view {
        // both orderings of the same conceptual pair produce a valid (>0) sqrt price
        uint160 a = script.encodeSqrtPrice(weth, usdc, 3000e18);
        uint160 b = script.encodeSqrtPrice(usdc, weth, 3000e18);
        assertGt(a, 0, "weth/usdc nonzero");
        assertGt(b, 0, "usdc/weth nonzero");
    }
}
