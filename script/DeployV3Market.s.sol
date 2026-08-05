// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {FeeArenaV3} from "../src/FeeArenaV3.sol";
import {IFeeArenaV3} from "../src/interfaces/IFeeArenaV3.sol";
import {PythPriceOracle} from "../src/oracles/PythPriceOracle.sol";
import {Config} from "./config/Config.sol";
import {CreatePool} from "./CreatePool.s.sol";

/// @notice GENERIC entry-anchored (v3) market deployer: a base/quote V3 pool + a FeeArenaV3 bound to
///         it, reusing the SHARED infra (factory/NPM) by address. Both BASE and QUOTE are EXISTING
///         tokens (no mock deploy). The QUOTE may be USDC OR another 6-dp stablecoin (e.g. EURC) - the
///         contract only requires the quote leg to be 6-dp, so a EURC-quoted market binds cleanly.
///
///         ORACLE: pass ORACLE_ADDRESS to REUSE an existing PythPriceOracle (e.g. share the BTC/USD
///         oracle across a cirBTC/USDC and a cirBTC/EURC market), or pass MARKET_FEED to deploy a
///         fresh PythPriceOracle for that feed. The arena settles on the BASE asset's feed direction;
///         the quote token only denominates fees/pots.
///
///         FUNDING: deploys are gas-only (Arc gas = native USDC). Liquidity is seeded SEPARATELY via
///         direct cast send (Arc's stablecoin compliance precompile reverts token transfers inside
///         forge's local revm sim), so this script never moves tokens.
///
///         Env: PRIVATE_KEY, NPM_ADDRESS, FACTORY_ADDRESS, BASE_TOKEN, BASE_DECIMALS; QUOTE_TOKEN
///         (default USDC); ORACLE_ADDRESS xor MARKET_FEED; INIT_PRICE_18 (quote per 1 base, 18dp);
///         FEE_TIER, BAND_BPS, ENTRY_WINDOW, LOCK_DURATION, MAX_PRICE_AGE, SETTLE_SANITY_BPS,
///         MIN_LIQUIDITY, KEEPER_ADDRESS. Stack-shallow (struct + helpers) so it compiles w/o via-IR.
contract DeployV3Market is Script, Config {
    struct P {
        address base;
        address quote;
        address npm;
        address factory;
        address owner;
        address oracle; // reused if nonzero
        bytes32 feed; // used only when oracle == 0
        uint24 fee;
        uint256 price18;
        uint8 baseDecimals;
        uint128 minLiq;
        uint32 entryWindow;
        uint32 lockDuration;
        uint32 maxPriceAge;
        int32 bandBps;
        uint32 settleSanityBps;
    }

    function _params(address owner) internal view returns (P memory p) {
        p.base = vm.envAddress("BASE_TOKEN");
        p.quote = vm.envOr("QUOTE_TOKEN", USDC);
        p.npm = vm.envAddress("NPM_ADDRESS");
        p.factory = vm.envAddress("FACTORY_ADDRESS");
        p.owner = owner;
        p.oracle = vm.envOr("ORACLE_ADDRESS", address(0));
        p.feed = vm.envOr("MARKET_FEED", bytes32(0));
        p.fee = feeTier();
        p.price18 = vm.envUint("INIT_PRICE_18"); // quote per 1 base, 18dp
        p.baseDecimals = uint8(vm.envUint("BASE_DECIMALS"));
        p.minLiq = uint128(vm.envOr("MIN_LIQUIDITY", uint256(DEFAULT_MIN_LIQUIDITY)));
        p.entryWindow = uint32(vm.envOr("ENTRY_WINDOW", uint256(300)));
        p.lockDuration = uint32(vm.envOr("LOCK_DURATION", uint256(600)));
        p.maxPriceAge = uint32(vm.envOr("MAX_PRICE_AGE", uint256(900)));
        p.bandBps = int32(vm.envOr("BAND_BPS", int256(20)));
        p.settleSanityBps = uint32(vm.envOr("SETTLE_SANITY_BPS", uint256(100)));
    }

    function _deployCore(P memory p) internal returns (address oracleAddr, address poolAddr, address arenaAddr) {
        // Reuse an existing oracle when ORACLE_ADDRESS is set; else deploy a fresh one for MARKET_FEED.
        if (p.oracle != address(0)) {
            oracleAddr = p.oracle;
            console2.log("Oracle (reused)  :", oracleAddr);
        } else {
            require(p.feed != bytes32(0), "set ORACLE_ADDRESS or MARKET_FEED");
            oracleAddr = address(new PythPriceOracle(PYTH, p.feed));
            console2.log("Oracle (new)     :", oracleAddr);
        }

        CreatePool pools = new CreatePool();
        uint160 sp = pools.encodeSqrtPrice(p.base, p.quote, p.price18, p.baseDecimals);
        poolAddr = pools.createPool(p.factory, p.npm, p.base, p.quote, p.fee, sp);
        console2.log("Pool             :", poolAddr);

        FeeArenaV3 arena = new FeeArenaV3(_boot(p, poolAddr, oracleAddr));
        arenaAddr = address(arena);
        console2.log("FeeArenaV3       :", arenaAddr);
    }

    function _boot(P memory p, address poolAddr, address oracleAddr)
        internal
        pure
        returns (IFeeArenaV3.BootConfig memory)
    {
        return IFeeArenaV3.BootConfig({
            usdc: p.quote, // the 6-dp quote leg (USDC or EURC) - contract only checks 6dp
            base: p.base,
            pool: poolAddr,
            npm: p.npm,
            factory: p.factory,
            oracle: oracleAddr,
            owner: p.owner,
            feeTier: p.fee,
            minLiquidity: p.minLiq,
            entryWindow: p.entryWindow,
            lockDuration: p.lockDuration,
            maxPriceAge: p.maxPriceAge,
            bandBps: p.bandBps,
            settleSanityBps: p.settleSanityBps
        });
    }

    function run() external returns (address oracleAddr, address poolAddr, address arenaAddr) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        P memory p = _params(vm.addr(pk));
        vm.startBroadcast(pk);
        (oracleAddr, poolAddr, arenaAddr) = _deployCore(p);
        address keeperAddr = vm.envOr("KEEPER_ADDRESS", address(0));
        if (keeperAddr != address(0)) {
            FeeArenaV3(payable(arenaAddr)).setKeeper(keeperAddr);
            console2.log("Keeper           :", keeperAddr);
        }
        vm.stopBroadcast();
        console2.log("base / quote / baseDecimals:", p.base, p.quote, uint256(p.baseDecimals));
    }
}
