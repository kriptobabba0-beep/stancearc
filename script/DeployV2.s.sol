// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FeeArenaV2} from "../src/FeeArenaV2.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {PythPriceOracleV2} from "../src/oracles/PythPriceOracleV2.sol";
import {WETH9} from "../src/mocks/WETH9.sol";
import {TestERC20} from "../src/mocks/TestERC20.sol";
import {Config} from "./config/Config.sol";
import {CreatePool} from "./CreatePool.s.sol";
import {V3Deployer} from "../test/utils/V3Deployer.sol";

/// @notice Deploys FeeArena **v2** (conviction-parimutuel + bounded subsidy, BURN-on-loss) wired to
///         the PINNED v2 oracle (PythPriceOracleV2.getPinnedPrice -> parsePriceFeedUpdates) and the
///         extended {FeeArenaV2.BootConfigV2}: treasury, conviction bounds, settleWindow, maxConfBps,
///         maxSubsidyPerEpoch, and a NON-ZERO maxStakesPerEpoch (spec §MIGRATION 1).
/// @dev Mirrors {Deploy} (V1) structurally so the same env/CI plumbing applies:
///        - `deployFeeArenaV2(Params)` is the unit-testable core (no broadcast).
///        - `run()` is the Arc-testnet broadcast path: V3 fork (or env addresses) + WETH9 + pool +
///          oracle + arena, then an optional least-privilege keeper.
///      USE_PYTH=true wires the real {PythPriceOracleV2} at PYTH (feed PYTH_FEED_ID, default
///      cirBTC/USD per the real-token market); otherwise a seeded {MockPriceOracle} (which ALSO
///      implements getPinnedPrice) is used for local simulation. via_ir is OFF - helpers stack-shallow.
///
///      KEY SEPARATION (spec §STAKEFLOW / §MIGRATION 3): the keeper, the arb-bot, and any
///      conviction-holder key MUST be distinct - v2 enforces `msg.sender != keeper/owner` at stake.
contract DeployV2 is Script, Config {
    // ---- v2 default conviction/oracle config (env-overridable) ----
    // Dust-gate (asserted at boot): maxSubsidyPerEpoch < 2*minConv. Defaults keep 100/1000 USDC
    // bounds (10x), a 60s pin window (<=60s cap; 12s proved too tight live on Arc), a 25bps conf bound (<< 150bps band), a
    // 64/epoch sweep bound, and a 150 USDC per-epoch subsidy cap (< 2*100 = 200).
    uint256 public constant DEFAULT_MIN_CONV = 100e6;
    uint256 public constant DEFAULT_MAX_CONV = 1000e6;
    // 60s, not 12s: live on Arc the keeper missed the tight 12s pinned publishTime window
    // (PriceFeedNotFoundWithinRange); 60s (=hard cap) gives Hermes+mine headroom. BTC moves only
    // bps over 60s vs the 30bps band, so the fairness impact of the wider pin is negligible.
    uint32 public constant DEFAULT_SETTLE_WINDOW = 60;
    uint32 public constant DEFAULT_MAX_CONF_BPS = 25;
    uint32 public constant DEFAULT_MAX_STAKES_EPOCH = 64;
    uint256 public constant DEFAULT_MAX_SUBSIDY = 150e6;

    struct Params {
        address usdc;
        address weth;
        address pool;
        address npm;
        address factory;
        address oracleOwner;
        address owner;
        address treasury;
        uint24 feeTier;
        uint128 minLiquidity;
        uint256 seedPrice18;
    }

    /// @dev Unit-testable: deploys the v2 oracle (pinned Pyth adapter under USE_PYTH, else a seeded
    ///      mock) + FeeArenaV2 with the approved demo timings/band + the v2 conviction config wired
    ///      via {FeeArenaV2.BootConfigV2}.
    function deployFeeArenaV2(Params memory p) public returns (FeeArenaV2 arena) {
        // v2 real-oracle path: the PINNED adapter exposing getPinnedPrice (parsePriceFeedUpdates).
        if (vm.envOr("USE_PYTH", false)) {
            bytes32 feed = vm.envOr("PYTH_FEED_ID", PYTH_BTC_USD); // default cirBTC/USD market
            PythPriceOracleV2 pythOracle = new PythPriceOracleV2(PYTH, feed);
            console2.log("Oracle (pyth v2):", address(pythOracle));
            arena = new FeeArenaV2(_boot(p, address(pythOracle)));
            return arena;
        }

        // Default (local simulation): mock oracle (also implements getPinnedPrice), seeded + handed off.
        MockPriceOracle oracle = new MockPriceOracle();
        if (p.seedPrice18 > 0) {
            oracle.setPrice(p.seedPrice18);
        }
        if (p.oracleOwner != address(0) && Ownable(address(oracle)).owner() != p.oracleOwner) {
            Ownable(address(oracle)).transferOwnership(p.oracleOwner);
        }
        arena = new FeeArenaV2(_boot(p, address(oracle)));
    }

    /// @dev Build the v2 BootConfig: v1 timing/band (env-configurable EPOCH_DURATION/BAND_BPS) +
    ///      the v2 treasury/conviction/oracle config (env-overridable). Extracted to keep
    ///      `deployFeeArenaV2`'s legacy-pipeline stack shallow (via_ir off).
    function _boot(Params memory p, address oracle) internal view returns (FeeArenaV2.BootConfigV2 memory) {
        uint32 epochDuration = uint32(vm.envOr("EPOCH_DURATION", uint256(DEMO_EPOCH_DURATION)));
        int32 bandBps = int32(vm.envOr("BAND_BPS", int256(DEFAULT_BAND_BPS)));
        return FeeArenaV2.BootConfigV2({
            usdc: p.usdc,
            weth: p.weth,
            pool: p.pool,
            npm: p.npm,
            factory: p.factory,
            oracle: oracle,
            owner: p.owner,
            feeTier: p.feeTier,
            minLiquidity: p.minLiquidity,
            entryWindow: DEMO_ENTRY_WINDOW,
            epochDuration: epochDuration,
            minStartGap: DEFAULT_MIN_START_GAP,
            maxStartDelay: DEFAULT_MAX_START_DELAY,
            maxPriceAge: DEFAULT_MAX_PRICE_AGE,
            bandBps: bandBps,
            treasury: p.treasury,
            minConv: vm.envOr("MIN_CONV", DEFAULT_MIN_CONV),
            maxConv: vm.envOr("MAX_CONV", DEFAULT_MAX_CONV),
            settleWindow: uint32(vm.envOr("SETTLE_WINDOW", uint256(DEFAULT_SETTLE_WINDOW))),
            maxConfBps: uint32(vm.envOr("MAX_CONF_BPS", uint256(DEFAULT_MAX_CONF_BPS))),
            maxStakesPerEpoch: uint32(vm.envOr("MAX_STAKES_PER_EPOCH", uint256(DEFAULT_MAX_STAKES_EPOCH))),
            maxSubsidyPerEpoch: vm.envOr("MAX_SUBSIDY_PER_EPOCH", DEFAULT_MAX_SUBSIDY)
        });
    }

    /// @dev V3 fork resolution: reuse env addresses if all present, else deploy WETH9 + the V3 fork.
    function _resolveV3() internal returns (address wethAddr, address factoryAddr, address npmAddr) {
        factoryAddr = factory();
        npmAddr = npm();
        wethAddr = weth();
        if (factoryAddr == address(0) || npmAddr == address(0) || wethAddr == address(0)) {
            wethAddr = address(new WETH9());
            V3Deployer.V3 memory v3 = V3Deployer.deploy(wethAddr);
            factoryAddr = address(v3.factory);
            npmAddr = address(v3.npm);
            console2.log("WETH9        :", wethAddr);
            console2.log("Factory      :", factoryAddr);
            console2.log("NPM          :", npmAddr);
            console2.log("SwapRouter   :", address(v3.router));
        }
    }

    /// @dev Create + init the demo pool (mirrors Deploy._makePool). Base decimals derived on-chain.
    function _makePool(address wethAddr, address usdcAddr, address factoryAddr, address npmAddr, uint24 fee)
        internal
        returns (address poolAddr)
    {
        CreatePool pools = new CreatePool();
        uint8 baseDecimals = _baseDecimals(wethAddr, uint8(vm.envOr("BASE_DECIMALS", uint256(18))));
        require(baseDecimals >= 6 && baseDecimals <= 18, "baseDecimals out of range [6,18]");
        uint160 sp =
            pools.encodeSqrtPrice(wethAddr, usdcAddr, vm.envOr("INIT_PRICE_18", DEFAULT_PRICE_18), baseDecimals);
        poolAddr = pools.createPool(factoryAddr, npmAddr, wethAddr, usdcAddr, fee, sp);
        console2.log("Pool         :", poolAddr);
    }

    function _baseDecimals(address baseToken, uint8 fallbackDecimals) internal view returns (uint8) {
        (bool ok, bytes memory ret) = baseToken.staticcall(abi.encodeWithSelector(IERC20Metadata.decimals.selector));
        if (ok && ret.length >= 32) {
            return uint8(abi.decode(ret, (uint256)));
        }
        return fallbackDecimals;
    }

    /// @dev Resolve USDC: env/canonical Arc address, or a 6-dp mock under pure local sim.
    function _resolveUsdc() internal returns (address usdcAddr) {
        usdcAddr = usdc();
        if (usdcAddr.code.length == 0) {
            usdcAddr = address(new TestERC20("USD Coin", "USDC", 6));
            console2.log("USDC (mock)  :", usdcAddr);
        }
    }

    /// @notice Full v2 deploy: V3 fork (or env addresses) + WETH9 + pool + v2 oracle + FeeArenaV2.
    ///         TREASURY defaults to the deployer if TREASURY_ADDRESS is unset (override on testnet
    ///         with a non-blockable sink, spec §OPENRISKS 5).
    function run() external returns (FeeArenaV2 arena) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint24 fee = feeTier();
        address usdcAddr = _resolveUsdc();
        address treasuryAddr = vm.envOr("TREASURY_ADDRESS", deployer);

        vm.startBroadcast(pk);
        (address wethAddr, address factoryAddr, address npmAddr) = _resolveV3();
        address poolAddr = _makePool(wethAddr, usdcAddr, factoryAddr, npmAddr, fee);
        arena = deployFeeArenaV2(
            Params({
                usdc: usdcAddr,
                weth: wethAddr,
                pool: poolAddr,
                npm: npmAddr,
                factory: factoryAddr,
                oracleOwner: deployer,
                owner: deployer,
                treasury: treasuryAddr,
                feeTier: fee,
                minLiquidity: uint128(vm.envOr("MIN_LIQUIDITY", uint256(DEFAULT_MIN_LIQUIDITY))),
                seedPrice18: vm.envOr("SEED_PRICE_18", DEFAULT_PRICE_18)
            })
        );

        // Optional least-privilege keeper (createEpoch/openEntry only). MUST be distinct from any
        // conviction-holder key (operator-exclusion). Unset => owner runs the lifecycle.
        address keeperAddr = vm.envOr("KEEPER_ADDRESS", address(0));
        if (keeperAddr != address(0)) {
            arena.setKeeper(keeperAddr);
            console2.log("Keeper       :", keeperAddr);
        }
        vm.stopBroadcast();

        console2.log("FeeArenaV2   :", address(arena));
        console2.log("Oracle       :", arena.oracle());
        console2.log("Treasury     :", arena.TREASURY());
        console2.log("Owner        :", arena.owner());
    }
}
