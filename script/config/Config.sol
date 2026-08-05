// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";

/// @title Config - shared deploy/demo configuration for Fee Arena V0 scripts.
/// @notice Holds the canonical Arc addresses + the demo timing/band parameters and
///         reads the deployed Uniswap V3 fork addresses from the environment (filled
///         by the DeployMocks/CreatePool/Deploy scripts). Inherits forge-std `Script`
///         so `vm.envOr` resolves and so consuming scripts can `is Config`. Pure
///         config plumbing - NO protocol logic lives here.
/// @dev D1 reconciles the F9 baseline (USDC/MULTICALL3 constants + internal env
///      getters) with the deployment-component surface: env-overridable address
///      loaders, the public `envOr` overloads, and the demo timing/band constants
///      snapshotted into FeeArena's BootConfig at deploy.
contract Config is Script {
    // ---- Arc testnet facts (docs.arc.io 2026-06-04) ----

    /// @notice Canonical Arc testnet USDC (6-dp ERC-20). Spec §canonical addresses.
    address public constant USDC = 0x3600000000000000000000000000000000000000;
    /// @notice Canonical Multicall3 on Arc.
    address public constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    /// @notice Arc testnet chain id.
    uint256 public constant ARC_CHAIN_ID = 5042002;
    /// @notice Default V3 fee tier the Arena pool uses (0.30%).
    uint24 public constant DEFAULT_FEE_TIER = 3000;

    // ---- demo timing / band parameters (approved Decisions: 2min entry / 5min epoch) ----
    // Mirror the FeeArena published constants (DEMO_* / DEFAULT_*) so the deploy
    // scripts can construct the BootConfig without importing the core just for them.

    /// @notice Demo entry window (2 minutes) -> FeeArena.DEMO_ENTRY_WINDOW.
    uint32 public constant DEMO_ENTRY_WINDOW = 120;
    /// @notice Demo epoch duration (5 minutes) -> FeeArena.DEMO_EPOCH_DURATION.
    uint32 public constant DEMO_EPOCH_DURATION = 300;
    /// @notice Min gap between entry close and start (30s) -> DEFAULT_MIN_START_GAP.
    uint32 public constant DEFAULT_MIN_START_GAP = 30;
    /// @notice Max start delay (10 minutes) -> DEFAULT_MAX_START_DELAY.
    uint32 public constant DEFAULT_MAX_START_DELAY = 600;
    /// @notice Max oracle price age (10 minutes) -> DEFAULT_MAX_PRICE_AGE.
    uint32 public constant DEFAULT_MAX_PRICE_AGE = 600;
    /// @notice Default band (1.5%) -> DEFAULT_BAND_BPS.
    int32 public constant DEFAULT_BAND_BPS = 150;

    /// @notice Default demo MIN_LIQUIDITY floor for a stakeable position.
    uint128 public constant DEFAULT_MIN_LIQUIDITY = 1000;
    /// @notice Default seed/init ETH price (18-dp, $3000) for the mock oracle + pool.
    uint256 public constant DEFAULT_PRICE_18 = 3000e18;

    // ---- Pyth on Arc testnet (V1 real oracle) ----

    // Pyth on Arc testnet (V1 real oracle): pull contract + ETH/USD feed id.
    address public constant PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;
    bytes32 public constant PYTH_ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    /// @notice Pyth BTC/USD feed id on Arc testnet (multi-market: BTC/USDC). Verified live ~$59.7k.
    bytes32 public constant PYTH_BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    // ---- canonical-address accessor aliases (match the script test surface) ----

    /// @notice Alias for {USDC} (some scripts/tests read it as a `*_ADDRESS` accessor).
    function USDC_ADDRESS() public pure returns (address) {
        return USDC;
    }

    // ---- env-overridable deployed addresses (read in scripts via vm.envOr) ----

    function npm() public view returns (address) {
        return vm.envOr("NPM_ADDRESS", address(0));
    }

    function factory() public view returns (address) {
        return vm.envOr("FACTORY_ADDRESS", address(0));
    }

    function swapRouter() public view returns (address) {
        return vm.envOr("SWAP_ROUTER_ADDRESS", address(0));
    }

    function pool() public view returns (address) {
        return vm.envOr("POOL_ADDRESS", address(0));
    }

    function weth() public view returns (address) {
        return vm.envOr("WETH_ADDRESS", address(0));
    }

    function oracle() public view returns (address) {
        return vm.envOr("ORACLE_ADDRESS", address(0));
    }

    function feeArena() public view returns (address) {
        return vm.envOr("FEE_ARENA_ADDRESS", address(0));
    }

    function usdc() public view returns (address) {
        return vm.envOr("USDC_ADDRESS", USDC);
    }

    function feeTier() public view returns (uint24) {
        return uint24(vm.envOr("FEE_TIER", uint256(DEFAULT_FEE_TIER)));
    }

    // ---- generic env loaders (default-when-unset) ----

    /// @notice `vm.envOr` for a uint (returns `dflt` when the env var is unset/empty).
    function envOr(string memory key, uint256 dflt) public view returns (uint256) {
        return vm.envOr(key, dflt);
    }

    /// @notice `vm.envOr` for an address (returns `dflt` when the env var is unset/empty).
    function envOr(string memory key, address dflt) public view returns (address) {
        return vm.envOr(key, dflt);
    }

    /// @notice `vm.envOr` for a string (returns `dflt` when the env var is unset/empty).
    function envOr(string memory key, string memory dflt) public view returns (string memory) {
        return vm.envOr(key, dflt);
    }
}
