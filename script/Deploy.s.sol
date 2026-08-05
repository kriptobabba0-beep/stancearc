// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FeeArena} from "../src/FeeArena.sol";
import {IFeeArena} from "../src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {PythPriceOracle} from "../src/oracles/PythPriceOracle.sol";
import {WETH9} from "../src/mocks/WETH9.sol";
import {TestERC20} from "../src/mocks/TestERC20.sol";
import {Config} from "./config/Config.sol";
import {DeployMocks} from "./DeployMocks.s.sol";
import {CreatePool} from "./CreatePool.s.sol";
import {V3Deployer} from "../test/utils/V3Deployer.sol";

/// @notice Deploys MockPriceOracle + FeeArena wired to USDC/WETH/POOL/NPM/FACTORY with DEMO timings.
/// @dev The unit-testable {deployFeeArena} composes D2 (oracle) + the FeeArena BootConfig
///      constructor. {run} is the full Arc-testnet path: it deploys the V3 fork (factory/NPM/
///      router via the V3Deployer approach) + WETH9 + the pool + the arena, or reuses
///      env-provided addresses when present. via_ir is OFF - helpers are kept stack-shallow.
contract Deploy is Script, Config {
    struct Params {
        address usdc;
        address weth;
        address pool;
        address npm;
        address factory;
        address oracleOwner;
        address owner;
        uint24 feeTier;
        uint128 minLiquidity;
        uint256 seedPrice18;
    }

    /// @dev Unit-testable: deploys the oracle (owned by `oracleOwner`, seeded) + FeeArena with
    ///      the approved demo timings/band, wired via the canonical BootConfig struct.
    function deployFeeArena(Params memory p) public returns (FeeArena arena) {
        // V1 real-oracle path: deploy the Pyth adapter and wire FeeArena at it. The
        // adapter ctor only stores addresses (no owner/seed), so the mock-only
        // ownership-transfer + seed steps are skipped on this branch.
        if (vm.envOr("USE_PYTH", false)) {
            // Default to ETH/USD so the existing ETH market is unchanged; override via PYTH_FEED_ID
            // (e.g. PYTH_BTC_USD for the cirBTC/USDC market).
            bytes32 feed = vm.envOr("PYTH_FEED_ID", PYTH_ETH_USD);
            PythPriceOracle pythOracle = new PythPriceOracle(PYTH, feed);
            console2.log("Oracle (pyth):", address(pythOracle));
            arena = new FeeArena(_boot(p, address(pythOracle)));
            return arena;
        }

        // Default (local simulation): mock oracle, seeded + ownership handed off.
        MockPriceOracle oracle = new MockPriceOracle(); // owner == this contract / broadcaster
        if (p.seedPrice18 > 0) {
            oracle.setPrice(p.seedPrice18);
        }
        if (p.oracleOwner != address(0) && Ownable(address(oracle)).owner() != p.oracleOwner) {
            Ownable(address(oracle)).transferOwnership(p.oracleOwner);
        }

        arena = new FeeArena(_boot(p, address(oracle)));
    }

    /// @dev Build the BootConfig from `Params` + this script's demo timing/band constants.
    ///      Extracted to keep `deployFeeArena`'s legacy-pipeline stack shallow (via_ir off).
    ///      Epoch + band are env-configurable (`EPOCH_DURATION`/`BAND_BPS` via vm.envOr) defaulting
    ///      to the legacy demo constants, so a deploy can emit a custom (e.g. 600s/20bps) arena while
    ///      an unset env keeps the legacy ETH path unchanged.
    function _boot(Params memory p, address oracle) internal view returns (IFeeArena.BootConfig memory) {
        uint32 epochDuration = uint32(vm.envOr("EPOCH_DURATION", uint256(DEMO_EPOCH_DURATION)));
        int32 bandBps = int32(vm.envOr("BAND_BPS", int256(DEFAULT_BAND_BPS)));
        return IFeeArena.BootConfig({
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
            bandBps: bandBps
        });
    }

    /// @dev V3 fork resolution: reuse env addresses if all present, else deploy WETH9 + the
    ///      V3 fork locally. Returns (weth, factory, npm). Kept in its own frame for stack depth.
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

    /// @dev Create + init the demo pool. Separate frame keeps `run` within the legacy stack limit.
    function _makePool(address wethAddr, address usdcAddr, address factoryAddr, address npmAddr, uint24 fee)
        internal
        returns (address poolAddr)
    {
        CreatePool pools = new CreatePool();
        // DERIVE base decimals on-chain from the just-deployed token so an 8-dp base (e.g. cirBTC) can
        // never be mis-seeded by 10^10 via a forgotten BASE_DECIMALS env var. The env value is only
        // the fallback if the token does not expose decimals(); default 18-dp keeps the legacy path.
        uint8 baseDecimals = _baseDecimals(wethAddr, uint8(vm.envOr("BASE_DECIMALS", uint256(18))));
        // Range check: a fat-fingered value fails loudly instead of mis-seeding the pool.
        require(baseDecimals >= 6 && baseDecimals <= 18, "baseDecimals out of range [6,18]");
        uint160 sp =
            pools.encodeSqrtPrice(wethAddr, usdcAddr, vm.envOr("INIT_PRICE_18", DEFAULT_PRICE_18), baseDecimals);
        poolAddr = pools.createPool(factoryAddr, npmAddr, wethAddr, usdcAddr, fee, sp);
        console2.log("Pool         :", poolAddr);
    }

    /// @dev Derive the base token's decimals from the chain (`IERC20Metadata.decimals()`); fall back
    ///      to the env/default `fallbackDecimals` only if the token does not expose `decimals()`.
    ///      On-chain value is authoritative so the seed can't be mis-set by a stale env var.
    /// @dev Uses a LOW-LEVEL staticcall (not a high-level `try`) so a no-code address falls back
    ///      gracefully instead of reverting with "call to non-contract address".
    function _baseDecimals(address baseToken, uint8 fallbackDecimals) internal view returns (uint8) {
        (bool ok, bytes memory ret) = baseToken.staticcall(abi.encodeWithSelector(IERC20Metadata.decimals.selector));
        if (ok && ret.length >= 32) {
            return uint8(abi.decode(ret, (uint256)));
        }
        return fallbackDecimals;
    }

    /// @dev Resolve the USDC token: the env/canonical address on Arc (real ERC-20 USDC), or - when
    ///      that address has NO code (pure local simulation without a fork) - a 6-dp mock so the
    ///      boot-assert `USDC.decimals()==6` resolves. The real broadcast path is unaffected.
    function _resolveUsdc() internal returns (address usdcAddr) {
        usdcAddr = usdc();
        if (usdcAddr.code.length == 0) {
            usdcAddr = address(new TestERC20("USD Coin", "USDC", 6));
            console2.log("USDC (mock)  :", usdcAddr);
        }
    }

    /// @notice Full deploy: V3 fork (or env addresses) + WETH9 + pool + oracle + FeeArena.
    function run() external returns (FeeArena arena) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint24 fee = feeTier();
        address usdcAddr = _resolveUsdc();

        vm.startBroadcast(pk);
        (address wethAddr, address factoryAddr, address npmAddr) = _resolveV3();
        address poolAddr = _makePool(wethAddr, usdcAddr, factoryAddr, npmAddr, fee);
        arena = deployFeeArena(
            Params({
                usdc: usdcAddr,
                weth: wethAddr,
                pool: poolAddr,
                npm: npmAddr,
                factory: factoryAddr,
                oracleOwner: deployer,
                owner: deployer,
                feeTier: fee,
                minLiquidity: uint128(vm.envOr("MIN_LIQUIDITY", uint256(DEFAULT_MIN_LIQUIDITY))),
                seedPrice18: vm.envOr("SEED_PRICE_18", DEFAULT_PRICE_18)
            })
        );

        // Optional: wire a least-privilege keeper (createEpoch/openEntry only) if provided.
        // Done inside the broadcast because the deployer EOA is the arena owner. If unset,
        // keeper stays address(0) and the owner runs the lifecycle itself.
        address keeperAddr = vm.envOr("KEEPER_ADDRESS", address(0));
        if (keeperAddr != address(0)) {
            arena.setKeeper(keeperAddr);
            console2.log("Keeper       :", keeperAddr);
        }

        vm.stopBroadcast();

        console2.log("FeeArena     :", address(arena));
        console2.log("Oracle       :", arena.ORACLE());
        console2.log("Owner        :", arena.owner());
    }
}
