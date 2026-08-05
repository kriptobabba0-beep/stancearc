// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {FeeArena} from "../src/FeeArena.sol";
import {IFeeArena} from "../src/interfaces/IFeeArena.sol";

/// @notice Redeploy FeeArena (to ship a contract feature - e.g. the auto-return unstakeBatch)
///         bound to the SAME pool/oracle/NPM/factory and with the SAME timing/band/caps/keeper
///         as a LIVE arena, every value read 1:1 off the old contract so nothing can drift.
///         The old arena is left untouched - it simply stops being cranked once the keeper
///         and frontend re-point. Intended for a zero-live-stakes cutover window.
///
///         Env: PRIVATE_KEY (deployer = new owner), OLD_ARENA (the live arena to clone).
contract RedeployArena is Script {
    function run() external returns (address newArena) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        FeeArena old = FeeArena(payable(vm.envAddress("OLD_ARENA")));

        IFeeArena.BootConfig memory c = IFeeArena.BootConfig({
            usdc: old.USDC(),
            weth: old.WETH(),
            pool: old.POOL(),
            npm: old.NPM(),
            factory: old.FACTORY(),
            oracle: old.ORACLE(),
            owner: vm.addr(pk),
            feeTier: old.FEE_TIER(),
            minLiquidity: old.MIN_LIQUIDITY(),
            entryWindow: old.entryWindow(),
            epochDuration: old.epochDuration(),
            minStartGap: old.minStartGap(),
            maxStartDelay: old.maxStartDelay(),
            maxPriceAge: old.maxPriceAge(),
            bandBps: old.bandBps()
        });

        vm.startBroadcast(pk);
        FeeArena a = new FeeArena(c);

        // Mirror the mutable post-deploy config: stake caps + least-privilege keeper.
        (uint32 capEpoch, uint32 capUser) = (old.maxStakesPerEpoch(), old.maxStakesPerUser());
        if (capEpoch != a.maxStakesPerEpoch() || capUser != a.maxStakesPerUser()) {
            a.setStakeCaps(capEpoch, capUser);
        }
        address k = old.keeper();
        if (k != address(0)) a.setKeeper(k);
        vm.stopBroadcast();

        newArena = address(a);
        console2.log("Old arena    :", address(old));
        console2.log("New arena    :", newArena);
        console2.log("Pool         :", c.pool);
        console2.log("Oracle       :", c.oracle);
        console2.log("NPM          :", c.npm);
        console2.log("Keeper       :", k);
        console2.log("entryWindow  :", uint256(c.entryWindow));
        console2.log("epochDuration:", uint256(c.epochDuration));
        console2.log("bandBps      :", int256(c.bandBps));
        console2.log("capPerEpoch  :", uint256(capEpoch));
        console2.log("capPerUser   :", uint256(capUser));
    }
}
