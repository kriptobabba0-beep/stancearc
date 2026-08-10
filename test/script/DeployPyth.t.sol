// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PythPriceOracle} from "src/oracles/PythPriceOracle.sol";
import {Config} from "script/config/Config.sol";

contract DeployPythTest is Test {
    Config internal cfg;

    function setUp() public {
        cfg = new Config();
    }

    function test_constructs_with_arc_pyth_config() public {
        PythPriceOracle o = new PythPriceOracle(cfg.PYTH(), cfg.PYTH_ETH_USD());
        assertEq(address(o.pyth()), cfg.PYTH());
        assertEq(o.feedId(), cfg.PYTH_ETH_USD());
    }
}
