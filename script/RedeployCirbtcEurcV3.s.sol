// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {FeeArenaV3} from "../src/FeeArenaV3.sol";
import {IFeeArenaV3} from "../src/interfaces/IFeeArenaV3.sol";
import {CompositePythOracle} from "../src/oracles/CompositePythOracle.sol";

/// @notice ONE-OFF: re-deploy the cirBTC/EURC v3 arena bound to a NEW CompositePythOracle that quotes
///         cirBTC in EUR (BTC/EUR = BTC/USD ÷ EUR/USD) instead of BTC/USD - so the entry-anchored
///         settlement matches the EURC pool. REUSES the existing cirBTC/EURC pool (no new pool) and
///         matches every other param of the current arena (read live: entryWindow 300, lockDuration
///         600, maxPriceAge 900, bandBps 20, settleSanityBps 100, fee 3000, minLiquidity 1000). The old
///         arena (0xae3B…2797 + its BTC/USD oracle) is retired - update keeper/frontend to the new one.
///
///         Deploy is gas-only (Arc gas = native USDC); no token transfers. Env: PRIVATE_KEY (the owner).
contract RedeployCirbtcEurcV3 is Script {
    // ── Shared infra + tokens (Arc testnet) ──────────────────────────────────────────
    address constant PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;
    address constant NPM = 0x646E3cCd584b315F235aD269C0893a125D9F38dc;
    address constant FACTORY = 0x184b90622535b024AD178730f39b75D26EF04826;
    address constant CIRBTC = 0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF; // base (8dp)
    address constant EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a; // quote (6dp)
    address constant POOL = 0xEBCc92862e007220A90b407f92E90dAC3A98aD63; // existing cirBTC/EURC pool - REUSED
    address constant KEEPER = 0xB964fC0BB9d4226935Bb316E602c7E93455F359B; // lifecycle keeper

    // ── Pyth feeds for the cross rate BTC/EUR = BTC/USD ÷ EUR/USD ─────────────────────
    bytes32 constant BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant EUR_USD = 0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b;

    // ── Arena params - matched to the current cirBTC/EURC arena (read on-chain) ───────
    uint24 constant FEE_TIER = 3000;
    uint128 constant MIN_LIQUIDITY = 1000;
    uint32 constant ENTRY_WINDOW = 300;
    uint32 constant LOCK_DURATION = 600;
    uint32 constant MAX_PRICE_AGE = 900;
    int32 constant BAND_BPS = 20;
    uint32 constant SETTLE_SANITY_BPS = 100;

    function run() external returns (address oracleAddr, address arenaAddr) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(pk);
        vm.startBroadcast(pk);

        CompositePythOracle oracle = new CompositePythOracle(PYTH, BTC_USD, EUR_USD);
        oracleAddr = address(oracle);
        console2.log("CompositePythOracle (BTC/EUR):", oracleAddr);

        FeeArenaV3 arena = new FeeArenaV3(
            IFeeArenaV3.BootConfig({
                usdc: EURC, // the 6-dp quote leg (EURC) - contract only checks 6dp
                base: CIRBTC,
                pool: POOL, // REUSE the existing cirBTC/EURC pool
                npm: NPM,
                factory: FACTORY,
                oracle: oracleAddr, // the new BTC/EUR composite
                owner: owner,
                feeTier: FEE_TIER,
                minLiquidity: MIN_LIQUIDITY,
                entryWindow: ENTRY_WINDOW,
                lockDuration: LOCK_DURATION,
                maxPriceAge: MAX_PRICE_AGE,
                bandBps: BAND_BPS,
                settleSanityBps: SETTLE_SANITY_BPS
            })
        );
        arenaAddr = address(arena);
        console2.log("FeeArenaV3 cirBTC/EURC (new):", arenaAddr);

        arena.setKeeper(KEEPER);
        console2.log("Keeper set:", KEEPER);

        vm.stopBroadcast();
        console2.log("owner:", owner);
    }
}
