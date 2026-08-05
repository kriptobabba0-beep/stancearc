// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {FeeArenaV3} from "../src/FeeArenaV3.sol";
import {IFeeArenaV3} from "../src/interfaces/IFeeArenaV3.sol";

/// @notice Redeploy the cirBTC/USDC v3 arena with the O(1)-solvency bytecode (finalize gas is now
///         FLAT - the fix for the unbounded `_assertSolvent` loop that would have pushed finalize past
///         the 16,777,216 RPC gas cap and permanently wedged the market). Every BootConfig value is
///         read 1:1 off the LIVE arena (OLD_ARENA) so the pool/oracle/tokens/timing/band/caps/keeper
///         are identical - ONLY the contract code changes. The old arena is retired (keeper + frontend
///         re-point to the new one); it is left untouched. Gas-only deploy (Arc gas = native USDC).
///         Env: PRIVATE_KEY (deployer = new owner, the reserve signer), OLD_ARENA (the arena to clone).
contract RedeployCirbtcV3 is Script {
    function run() external returns (address newArena) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        FeeArenaV3 old = FeeArenaV3(payable(vm.envAddress("OLD_ARENA")));

        IFeeArenaV3.BootConfig memory c = IFeeArenaV3.BootConfig({
            usdc: old.USDC(),
            base: old.BASE(),
            pool: old.POOL(),
            npm: old.NPM(),
            factory: old.FACTORY(),
            oracle: old.ORACLE(),
            owner: vm.addr(pk),
            feeTier: old.FEE_TIER(),
            minLiquidity: old.MIN_LIQUIDITY(),
            entryWindow: old.entryWindow(),
            lockDuration: old.lockDuration(),
            maxPriceAge: old.maxPriceAge(),
            bandBps: old.bandBps(),
            settleSanityBps: old.settleSanityBps()
        });

        vm.startBroadcast(pk);
        FeeArenaV3 a = new FeeArenaV3(c);

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
        console2.log("Base (cirBTC):", c.base);
        console2.log("USDC         :", c.usdc);
        console2.log("Keeper       :", k);
        console2.log("entryWindow  :", uint256(c.entryWindow));
        console2.log("lockDuration :", uint256(c.lockDuration));
        console2.log("maxPriceAge  :", uint256(c.maxPriceAge));
        console2.log("bandBps      :", int256(c.bandBps));
        console2.log("settleSanity :", uint256(c.settleSanityBps));
        console2.log("capPerEpoch  :", uint256(capEpoch));
        console2.log("capPerUser   :", uint256(capUser));
    }
}
