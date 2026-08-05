// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {FeeArenaV3} from "../src/FeeArenaV3.sol";
import {IFeeArenaV3} from "../src/interfaces/IFeeArenaV3.sol";
import {FeeArena} from "../src/FeeArena.sol";

/// @notice Deploy the ENTRY-ANCHORED FeeArenaV3 bound to the SAME pool/oracle/NPM/factory
///         as a live v1 arena (read 1:1 off the old contract so the infra can't drift).
///         The v1 arena keeps running until the keeper/frontend re-point.
///
///         Env: PRIVATE_KEY (deployer = owner), OLD_ARENA (the live v1 arena to clone
///         infra from), optional ENTRY_WINDOW / LOCK_DURATION / BAND_BPS /
///         SETTLE_SANITY_BPS / MAX_PRICE_AGE overrides.
contract DeployV3 is Script {
    function run() external returns (address newArena) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        FeeArena old = FeeArena(payable(vm.envAddress("OLD_ARENA")));

        IFeeArenaV3.BootConfig memory c = IFeeArenaV3.BootConfig({
            usdc: old.USDC(),
            base: old.WETH(), // v1 names the non-USDC leg "WETH"; it IS cirBTC on this market
            pool: old.POOL(),
            npm: old.NPM(),
            factory: old.FACTORY(),
            oracle: old.ORACLE(),
            owner: vm.addr(pk),
            feeTier: old.FEE_TIER(),
            minLiquidity: old.MIN_LIQUIDITY(),
            entryWindow: uint32(vm.envOr("ENTRY_WINDOW", uint256(old.entryWindow()))),
            lockDuration: uint32(vm.envOr("LOCK_DURATION", uint256(old.epochDuration()))),
            maxPriceAge: uint32(vm.envOr("MAX_PRICE_AGE", uint256(old.maxPriceAge()))),
            bandBps: int32(vm.envOr("BAND_BPS", int256(old.bandBps()))),
            settleSanityBps: uint32(vm.envOr("SETTLE_SANITY_BPS", uint256(100)))
        });

        vm.startBroadcast(pk);
        FeeArenaV3 a = new FeeArenaV3(c);
        address k = old.keeper();
        if (k != address(0)) a.setKeeper(k);
        vm.stopBroadcast();

        newArena = address(a);
        console2.log("FeeArenaV3   :", newArena);
        console2.log("Pool         :", c.pool);
        console2.log("Oracle       :", c.oracle);
        console2.log("NPM          :", c.npm);
        console2.log("Keeper       :", k);
        console2.log("entryWindow  :", uint256(c.entryWindow));
        console2.log("lockDuration :", uint256(c.lockDuration));
        console2.log("bandBps      :", int256(c.bandBps));
        console2.log("sanityBps    :", uint256(c.settleSanityBps));
    }
}
