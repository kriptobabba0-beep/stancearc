// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WETH9} from "../src/mocks/WETH9.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";

/// @notice Deploys the WETH9-style test token + V0 MockPriceOracle (no canonical WETH on Arc testnet).
/// @dev The real {MockPriceOracle} uses a NO-ARG constructor (owner == deployer). To return an
///      oracle owned by an arbitrary `oracleOwner` (seeded under that ownership), the helper
///      deploys the oracle (this contract becomes owner), seeds the price, then transfers
///      ownership to `oracleOwner`. When the caller IS the owner (broadcast: deployer==owner;
///      tests: this contract), no transfer happens and the seed runs directly.
contract DeployMocks is Script {
    /// @dev Pure deploy helper (unit-testable). Deploys WETH9 + MockPriceOracle owned by
    ///      `oracleOwner`, seeded with `seedPrice18` (skipped when 0). Uses the oracle's
    ///      ACTUAL current owner (never `address(this)`, which broadcast scripts forbid)
    ///      to decide whether ownership must be handed off.
    function deployMocks(address oracleOwner, uint256 seedPrice18) public returns (address weth, address oracle) {
        WETH9 w = new WETH9();
        MockPriceOracle o = new MockPriceOracle(); // owner == whoever CREATEd it

        // Seed under the current owner's authority before handing ownership off. In a
        // broadcast run the broadcaster is the creator/owner and authorizes this; in a
        // plain unit test the deploying contract is the owner and authorizes it.
        if (seedPrice18 > 0) {
            o.setPrice(seedPrice18);
        }

        // Hand ownership to the requested oracle owner (no-op when already correct).
        if (oracleOwner != address(0) && Ownable(address(o)).owner() != oracleOwner) {
            Ownable(address(o)).transferOwnership(oracleOwner);
        }

        return (address(w), address(o));
    }

    function run() external returns (address weth, address oracle) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint256 seed = vm.envOr("SEED_PRICE_18", uint256(3000e18));
        vm.startBroadcast(pk);
        // deployer is the broadcaster; pass deployer as the oracle owner so the seed
        // and any later setPrice() cranks are authorized by the same key.
        (weth, oracle) = deployMocks(deployer, seed);
        vm.stopBroadcast();
        console2.log("WETH9        :", weth);
        console2.log("MockOracle   :", oracle);
        console2.log("OracleOwner  :", Ownable(oracle).owner());
    }
}
