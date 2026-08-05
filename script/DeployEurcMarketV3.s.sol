// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeArenaV3} from "../src/FeeArenaV3.sol";
import {IFeeArenaV3} from "../src/interfaces/IFeeArenaV3.sol";
import {PythPriceOracle} from "../src/oracles/PythPriceOracle.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3Pool.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {Config} from "./config/Config.sol";
import {CreatePool} from "./CreatePool.s.sol";

/// @notice Deploy a EURC/USDC ENTRY-ANCHORED (v3) Fee Arena market on Arc testnet - a EUR/USD
///         prediction market denominated with Circle's EURC. Stands up a fresh PythPriceOracle
///         (EUR/USD) + a new EURC/USDC V3 pool + a FeeArenaV3 whose BASE leg is the REAL Circle
///         EURC (no mock), reusing the SHARED infra (factory/NPM/USDC) by address.
///
///         This fits the frontend architecture cleanly: the global quote stays USDC, only the
///         per-market BASE token (EURC) + price feed (EUR/USD) change - exactly what lib/markets.ts
///         already parameterizes (baseSymbol/baseDecimals/feedId/pool/feeArena/oracle/version).
///
///         FUNDING: deploys are gas-only (Arc gas = native USDC). The OPTIONAL liquidity seed needs
///         the deployer to hold REAL EURC + USDC tokens (EURC from faucet.circle.com). Seeding is
///         SKIPPED unless SEED_BASE_RAW + SEED_USDC_RAW are both set.
///
///         Env: PRIVATE_KEY (deployer = owner), NPM_ADDRESS, FACTORY_ADDRESS; optional EURC_ADDRESS,
///         MARKET_FEED, INIT_PRICE_18, FEE_TIER, BAND_BPS, ENTRY_WINDOW, LOCK_DURATION, MAX_PRICE_AGE,
///         SETTLE_SANITY_BPS, MIN_LIQUIDITY, KEEPER_ADDRESS, SEED_BASE_RAW, SEED_USDC_RAW.
///
///         Structured into a params struct + helpers so it compiles without via-IR (stack-shallow).
contract DeployEurcMarketV3 is Script, Config {
    /// @notice Circle EURC on Arc testnet (6-dp). Verified on-chain: code present, decimals()=6, symbol()="EURC".
    address public constant EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a;
    /// @notice Pyth FX.EUR/USD feed id (served by Hermes; ~1.146 at time of writing).
    bytes32 public constant PYTH_EUR_USD = 0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b;

    struct EurcParams {
        address eurc;
        address usdc;
        address npm;
        address factory;
        address owner;
        bytes32 feed;
        uint24 fee;
        uint256 price18;
        uint8 baseDecimals;
        uint128 minLiq;
        uint32 entryWindow;
        uint32 lockDuration;
        uint32 maxPriceAge;
        int32 bandBps;
        uint32 settleSanityBps;
        uint256 seedBaseRaw;
        uint256 seedUsdcRaw;
    }

    /// @dev Read all config from env into a struct (keeps run() stack-shallow).
    function _params(address owner) internal view returns (EurcParams memory p) {
        p.eurc = vm.envOr("EURC_ADDRESS", EURC);
        p.usdc = usdc();
        p.npm = vm.envAddress("NPM_ADDRESS");
        p.factory = vm.envAddress("FACTORY_ADDRESS");
        p.owner = owner;
        p.feed = vm.envOr("MARKET_FEED", PYTH_EUR_USD);
        p.fee = feeTier();
        // USDC per 1 EURC, 18-dp. EUR/USD ~1.146; the arb keeps the live pool pegged after init.
        p.price18 = vm.envOr("INIT_PRICE_18", uint256(1_146_000_000_000_000_000));
        p.baseDecimals = uint8(vm.envOr("BASE_DECIMALS", uint256(6))); // EURC = 6dp
        p.minLiq = uint128(vm.envOr("MIN_LIQUIDITY", uint256(DEFAULT_MIN_LIQUIDITY)));
        p.entryWindow = uint32(vm.envOr("ENTRY_WINDOW", uint256(300)));
        p.lockDuration = uint32(vm.envOr("LOCK_DURATION", uint256(600)));
        p.maxPriceAge = uint32(vm.envOr("MAX_PRICE_AGE", uint256(900)));
        p.bandBps = int32(vm.envOr("BAND_BPS", int256(20)));
        p.settleSanityBps = uint32(vm.envOr("SETTLE_SANITY_BPS", uint256(100)));
        p.seedBaseRaw = vm.envOr("SEED_BASE_RAW", uint256(0));
        p.seedUsdcRaw = vm.envOr("SEED_USDC_RAW", uint256(0));
    }

    /// @dev Deploy oracle + create/init pool + deploy FeeArenaV3. Returns the three addresses.
    function _deployCore(EurcParams memory p)
        internal
        returns (address oracleAddr, address poolAddr, address arenaAddr)
    {
        oracleAddr = address(new PythPriceOracle(PYTH, p.feed));
        console2.log("Oracle (EUR/USD) :", oracleAddr);

        CreatePool pools = new CreatePool();
        uint160 sp = pools.encodeSqrtPrice(p.eurc, p.usdc, p.price18, p.baseDecimals);
        poolAddr = pools.createPool(p.factory, p.npm, p.eurc, p.usdc, p.fee, sp);
        console2.log("Pool (EURC/USDC) :", poolAddr);

        FeeArenaV3 arena = new FeeArenaV3(_boot(p, poolAddr, oracleAddr));
        arenaAddr = address(arena);
        console2.log("FeeArenaV3(EURC) :", arenaAddr);
    }

    /// @dev BootConfig for the EURC market: BASE = EURC, quote = USDC, bound to (pool, oracle).
    function _boot(EurcParams memory p, address poolAddr, address oracleAddr)
        internal
        pure
        returns (IFeeArenaV3.BootConfig memory)
    {
        return IFeeArenaV3.BootConfig({
            usdc: p.usdc,
            base: p.eurc,
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

    /// @dev OPTIONAL full-range liquidity seed (needs the deployer to hold EURC + USDC).
    function _seed(EurcParams memory p, address poolAddr) internal {
        IERC20(p.eurc).approve(p.npm, p.seedBaseRaw);
        IERC20(p.usdc).approve(p.npm, p.seedUsdcRaw);
        int24 spacing = IUniswapV3Pool(poolAddr).tickSpacing();
        int24 tickLower = (int24(-887272) / spacing) * spacing;
        int24 tickUpper = (int24(887272) / spacing) * spacing;
        address token0 = IUniswapV3Pool(poolAddr).token0();
        (uint256 amt0, uint256 amt1) =
            token0 == p.eurc ? (p.seedBaseRaw, p.seedUsdcRaw) : (p.seedUsdcRaw, p.seedBaseRaw);
        address token1 = token0 == p.eurc ? p.usdc : p.eurc;
        INonfungiblePositionManager.MintParams memory mp = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: p.fee,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: amt0,
            amount1Desired: amt1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: p.owner,
            deadline: block.timestamp + 3600
        });
        (uint256 tokenId,,,) = INonfungiblePositionManager(p.npm).mint(mp);
        console2.log("SeedTokenId      :", tokenId);
    }

    function run() external returns (address oracleAddr, address poolAddr, address arenaAddr) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        EurcParams memory p = _params(vm.addr(pk));

        vm.startBroadcast(pk);
        (oracleAddr, poolAddr, arenaAddr) = _deployCore(p);

        address keeperAddr = vm.envOr("KEEPER_ADDRESS", address(0));
        if (keeperAddr != address(0)) {
            FeeArenaV3(payable(arenaAddr)).setKeeper(keeperAddr);
            console2.log("Keeper           :", keeperAddr);
        }

        if (p.seedBaseRaw > 0 && p.seedUsdcRaw > 0) {
            _seed(p, poolAddr);
        }
        vm.stopBroadcast();

        console2.log("--- NEXT_PUBLIC_MARKETS: version v3, baseSymbol EURC, baseDecimals 6, feedId below ---");
        console2.logBytes32(p.feed);
    }
}
