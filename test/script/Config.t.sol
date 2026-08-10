// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Config} from "../../script/config/Config.sol";

/// @notice Verifies the reconciled (D1) Config surface: the hardcoded Arc facts,
///         the demo timing/band constants, the env-override address loaders, and the
///         generic `envOr` helpers used by the deploy scripts.
contract ConfigTest is Test {
    Config internal cfg;

    function setUp() public {
        cfg = new Config();
    }

    function test_HardcodedArcFacts() public view {
        assertEq(cfg.USDC(), 0x3600000000000000000000000000000000000000, "usdc const");
        assertEq(cfg.USDC_ADDRESS(), 0x3600000000000000000000000000000000000000, "usdc alias");
        assertEq(cfg.MULTICALL3(), 0xcA11bde05977b3631167028862bE2a173976CA11, "multicall3");
        assertEq(cfg.ARC_CHAIN_ID(), 5042002, "chainId");
        assertEq(uint256(cfg.DEFAULT_FEE_TIER()), 3000, "default fee tier");
    }

    function test_DemoTimingAndBandConstants() public view {
        assertEq(uint256(cfg.DEMO_ENTRY_WINDOW()), 120, "entry window 2min");
        assertEq(uint256(cfg.DEMO_EPOCH_DURATION()), 300, "epoch 5min");
        assertEq(uint256(cfg.DEFAULT_MIN_START_GAP()), 30, "min start gap 30s");
        assertEq(uint256(cfg.DEFAULT_MAX_START_DELAY()), 600, "max start delay 10min");
        assertEq(uint256(cfg.DEFAULT_MAX_PRICE_AGE()), 600, "max price age 10min");
        assertEq(int256(cfg.DEFAULT_BAND_BPS()), 150, "band 150bps");
        assertEq(uint256(cfg.DEFAULT_PRICE_18()), 3000e18, "seed price $3000");
    }

    function test_EnvOrDefault_UsesDefaultWhenUnset() public {
        // unset env -> default is returned
        vm.setEnv("FEE_ARENA_TEST_MISSING", "");
        assertEq(cfg.envOr("FEE_ARENA_TEST_MISSING", uint256(150)), 150, "default");
    }

    function test_EnvOrDefault_UsesEnvWhenSet() public {
        vm.setEnv("FEE_ARENA_TEST_BAND", "300");
        assertEq(cfg.envOr("FEE_ARENA_TEST_BAND", uint256(150)), 300, "env override");
    }

    function test_EnvAddressOrDefault() public {
        vm.setEnv("FEE_ARENA_TEST_ADDR", "0x000000000000000000000000000000000000dEaD");
        assertEq(cfg.envOr("FEE_ARENA_TEST_ADDR", address(0)), 0x000000000000000000000000000000000000dEaD, "addr env");
        assertEq(cfg.envOr("FEE_ARENA_TEST_ADDR_MISSING", address(1)), address(1), "addr default");
    }

    function test_DeployedAddressLoaders_DefaultToZeroOrCanonical() public {
        // unset deployment addresses default to the zero address...
        vm.setEnv("WETH_ADDRESS", "");
        vm.setEnv("NPM_ADDRESS", "");
        vm.setEnv("FACTORY_ADDRESS", "");
        vm.setEnv("SWAP_ROUTER_ADDRESS", "");
        vm.setEnv("POOL_ADDRESS", "");
        vm.setEnv("ORACLE_ADDRESS", "");
        vm.setEnv("FEE_ARENA_ADDRESS", "");
        assertEq(cfg.weth(), address(0), "weth default");
        assertEq(cfg.npm(), address(0), "npm default");
        assertEq(cfg.factory(), address(0), "factory default");
        assertEq(cfg.swapRouter(), address(0), "router default");
        assertEq(cfg.pool(), address(0), "pool default");
        assertEq(cfg.oracle(), address(0), "oracle default");
        assertEq(cfg.feeArena(), address(0), "feeArena default");
        // ...but usdc defaults to the canonical Arc USDC, not zero.
        vm.setEnv("USDC_ADDRESS", "");
        assertEq(cfg.usdc(), cfg.USDC(), "usdc default = canonical");
    }
}
