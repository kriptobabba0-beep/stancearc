// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {Config} from "../../script/config/Config.sol";
import {V3Deployer} from "../utils/V3Deployer.sol";
import {WETH9} from "../../src/mocks/WETH9.sol";
import {TestERC20} from "../../src/mocks/TestERC20.sol";
import {FeeArena} from "../../src/FeeArena.sol";
import {PythPriceOracle} from "../../src/oracles/PythPriceOracle.sol";
import {CreatePool} from "../../script/CreatePool.s.sol";

/// @notice Exercises the V1 USE_PYTH deploy branch (real Pyth oracle wiring). The Pyth
///         address has no code in the local test EVM, but PythPriceOracle's ctor only
///         stores addresses (no call), so construction + the getter assertions work
///         without a fork. Mirrors DeployTest's setUp + deployFeeArena invocation.
contract DeployUsePythTest is Test {
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

    function test_Deploy_UsePyth_WiresRealPythOracle() public {
        vm.setEnv("USE_PYTH", "true");

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

        // Restore the env IMMEDIATELY after the deploy branch we wanted to exercise, so a
        // failing assertion below cannot leak USE_PYTH into sibling tests in the same process.
        // Reset to "false" (not "") so `vm.envOr("USE_PYTH", false)` parses it as the bool
        // false; an empty string is not a valid bool and would not be treated as unset.
        vm.setEnv("USE_PYTH", "false");

        // The deployed oracle is a real PythPriceOracle (has code) wired to Config's Pyth facts.
        address oracleAddr = arena.ORACLE();
        assertGt(oracleAddr.code.length, 0, "oracle has code");

        Config cfg = new Config();
        PythPriceOracle pythOracle = PythPriceOracle(oracleAddr);
        assertEq(address(pythOracle.pyth()), cfg.PYTH(), "pyth contract wired");
        assertEq(pythOracle.feedId(), cfg.PYTH_ETH_USD(), "ETH/USD feed id wired");
    }
}
