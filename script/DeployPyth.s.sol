// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/Script.sol";
import {PythPriceOracle} from "src/oracles/PythPriceOracle.sol";
import {Config} from "script/config/Config.sol";

/// @notice Deploys PythPriceOracle (Arc testnet Pyth + ETH/USD). Log the address to paste
///         into the FeeArena deploy (BootConfig.oracle) and the frontend env.
/// @dev Inherits {Config} (which `is Script`) so the Pyth constants resolve as bare names -
///      this repo's Config holds them as contract `constant`s, not library constants.
contract DeployPyth is Config {
    function run() external returns (PythPriceOracle oracle) {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        oracle = new PythPriceOracle(PYTH, PYTH_ETH_USD);
        vm.stopBroadcast();
        console2.log("PythPriceOracle:", address(oracle));
        console2.log("  pyth :", PYTH);
    }
}
