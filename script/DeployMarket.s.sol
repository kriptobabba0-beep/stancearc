// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FeeArena} from "../src/FeeArena.sol";
import {IFeeArena} from "../src/interfaces/IFeeArena.sol";
import {PythPriceOracle} from "../src/oracles/PythPriceOracle.sol";
import {MockWBTC} from "../src/mocks/MockWBTC.sol";
import {TestERC20} from "../src/mocks/TestERC20.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3Pool.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {Config} from "./config/Config.sol";
import {CreatePool} from "./CreatePool.s.sol";

/// @notice Deploys ONE additional Fee Arena market (e.g. BTC/USDC) on top of the SHARED V3 infra
///         (factory/NPM/router/USDC) that `Deploy.s.sol` already stood up for the ETH market.
/// @dev Reuses the infra by ADDRESS (read from env) - it never re-forks V3. The flow mirrors
///      `Deploy.s.sol`'s pool-init + the demo `BootConfig`, parameterized by base token + decimals
///      + price + Pyth feed. `deployMarket(...)` is the unit-testable core (no broadcast) so the
///      sim test can drive it; `run()` is the Arc-testnet broadcast entrypoint. via_ir is OFF -
///      helpers are kept stack-shallow.
///
///      DECIMALS NOTE: `FeeArena._bootValidate` requires ONLY that USDC is 6-dp. The non-USDC
///      leg (`baseToken`) may have ANY decimals - 18-dp WETH or 8-dp WBTC both bind. The former
///      18-dp requirement on the base was vestigial (post-anti-manipulation, WETH_NOTIONAL_DIV is
///      not used as a winner metric). `MockWBTC` mirrors real WBTC at 8-dp and is the default base
///      for the BTC/USDC market. The price-init honors the base/USDC decimals either way.
contract DeployMarket is Script, Config {
    struct MarketParams {
        address usdc;
        address npm;
        address factory;
        address swapRouter;
        address owner;
        uint24 feeTier;
        uint128 minLiquidity;
        bytes32 feed; // Pyth feed id (BTC/USD by default)
        uint8 baseDecimals; // non-USDC leg decimals (any value binds to FeeArena; 8 = MockWBTC/real WBTC)
        uint256 priceUsdc18; // human price of 1 base token in USDC, 18-dp (e.g. 60_000e18)
        uint256 seedBaseRaw; // base-token raw amount to seed into the demo LP (0 = skip seeding)
        uint256 seedUsdcRaw; // USDC raw amount to seed into the demo LP (0 = skip seeding)
    }

    struct Deployed {
        address baseToken;
        address pool;
        address oracle;
        address arena;
    }

    /// @notice Unit-testable core: deploy base token + pool (+ optional demo seed) + Pyth oracle
    ///         + FeeArena bound to (pool, oracle). NO broadcast - the test drives this directly;
    ///         `run()` wraps it in startBroadcast/stopBroadcast.
    function deployMarket(MarketParams memory p) public returns (Deployed memory d) {
        // 1) Base token (the non-USDC leg). 8-dp -> MockWBTC (mirrors real WBTC); else a generic
        //    mintable token at that decimal count. Any decimals bind to FeeArena (USDC still 6-dp).
        d.baseToken = _deployBaseToken(p.baseDecimals);
        console2.log("BaseToken    :", d.baseToken);
        console2.log("BaseDecimals :", uint256(p.baseDecimals));

        // 2) Create + initialize the base/USDC pool at the configured price (decimal-aware).
        d.pool = _makePool(d.baseToken, p);
        console2.log("Pool         :", d.pool);

        // 3) Seed a tiny demo position via the NPM (skipped when amounts are 0 or in a sim where
        //    real-USDC transfers can't run - see test). Mirrors Deploy/DemoLive's full-range mint.
        //    The deployer EOA is threaded in so _seed funds/approves/receives as the broadcaster.
        if (p.seedBaseRaw > 0 && p.seedUsdcRaw > 0) {
            address deployer = vm.addr(vm.envUint("PRIVATE_KEY"));
            _seed(deployer, d.baseToken, d.pool, p);
        }

        // 4) Pyth oracle for THIS market's feed (generic feedId - BTC/USD by default).
        d.oracle = address(new PythPriceOracle(PYTH, p.feed));
        console2.log("Oracle       :", d.oracle);

        // 5) FeeArena bound to (base/USDC pool, oracle) via the same BootConfig/timings as Deploy.
        FeeArena arena = new FeeArena(_boot(p, d.baseToken, d.pool, d.oracle));
        d.arena = address(arena);

        console2.log("FeeArena     :", d.arena);
        console2.log("Owner        :", arena.owner());
    }

    /// @dev 8-dp -> MockWBTC (real-WBTC mirror); any other value -> a generic mintable token at
    ///      that decimal count. FeeArena accepts any non-USDC decimals post-anti-manipulation.
    function _deployBaseToken(uint8 baseDecimals) internal returns (address) {
        if (baseDecimals == 8) {
            return address(new MockWBTC());
        }
        return address(new TestERC20("Wrapped BTC", "WBTC", baseDecimals));
    }

    /// @dev Create + init the base/USDC pool at `priceUsdc18`. SINGLE SOURCE OF TRUTH: the decimal-
    ///      aware {CreatePool.encodeSqrtPrice}(base, usdc, price18, baseDecimals) is used for EVERY
    ///      base-decimal count (8-dp WBTC, 18-dp WETH, ...). The base decimals are DERIVED ON-CHAIN
    ///      from the just-deployed token (`IERC20Metadata.decimals()`), not trusted from the env knob,
    ///      so a forgotten `BASE_DECIMALS` can never silently re-introduce the 10^10 mis-seed. The env
    ///      value (`p.baseDecimals`) is only the fallback when the on-chain call is unavailable.
    function _makePool(address baseToken, MarketParams memory p) internal returns (address) {
        CreatePool pools = new CreatePool();
        uint8 bd = _baseDecimals(baseToken, p.baseDecimals);
        // Range check: a fat-fingered value fails loudly instead of mis-seeding the pool.
        require(bd >= 6 && bd <= 18, "baseDecimals out of range [6,18]");
        uint160 sp = pools.encodeSqrtPrice(baseToken, p.usdc, p.priceUsdc18, bd);
        return pools.createPool(p.factory, p.npm, baseToken, p.usdc, p.feeTier, sp);
    }

    /// @dev Derive the base token's decimals from the chain (`IERC20Metadata.decimals()`); fall back
    ///      to the env/default `fallbackDecimals` only if the token does not expose `decimals()`.
    ///      The on-chain value is authoritative so the seed can't be mis-set by a stale env var.
    /// @dev Uses a LOW-LEVEL staticcall (not a high-level `try`) so a no-code address falls back
    ///      gracefully instead of reverting with "call to non-contract address" - a high-level `try`
    ///      does NOT trap that case.
    function _baseDecimals(address baseToken, uint8 fallbackDecimals) internal view returns (uint8) {
        (bool ok, bytes memory ret) = baseToken.staticcall(abi.encodeWithSelector(IERC20Metadata.decimals.selector));
        if (ok && ret.length >= 32) {
            return uint8(abi.decode(ret, (uint256)));
        }
        return fallbackDecimals;
    }

    /// @dev Mint a tiny full-range demo position to the broadcaster EOA so the pool has liquidity.
    ///      `deployer` is the broadcaster EOA (vm.addr(pk)): the base token is minted to it,
    ///      both token approvals are made by it (inside the active broadcast), and the NFT
    ///      recipient is set to it - mirroring DemoLive's broadcaster-context pattern.
    ///      Full-range ticks are derived from the pool's tick spacing to be valid for any fee tier.
    function _seed(address deployer, address baseToken, address pool, MarketParams memory p) internal {
        TestERC20(baseToken).mint(deployer, p.seedBaseRaw); // demo mint (MockWBTC/TestERC20 share mint sig)
        IERC20(baseToken).approve(p.npm, p.seedBaseRaw);
        IERC20(p.usdc).approve(p.npm, p.seedUsdcRaw);

        // Derive full-range ticks valid for any fee tier by aligning to the pool's tick spacing.
        int24 spacing = IUniswapV3Pool(pool).tickSpacing();
        int24 tickLower = (int24(-887272) / spacing) * spacing;
        int24 tickUpper = (int24(887272) / spacing) * spacing;

        address token0 = IUniswapV3Pool(pool).token0();
        (uint256 a0, uint256 a1) = token0 == baseToken ? (p.seedBaseRaw, p.seedUsdcRaw) : (p.seedUsdcRaw, p.seedBaseRaw);
        address token1 = token0 == baseToken ? p.usdc : baseToken;

        INonfungiblePositionManager.MintParams memory mp = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: p.feeTier,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: a0,
            amount1Desired: a1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: deployer,
            deadline: block.timestamp + 3600
        });
        (uint256 tokenId,,,) = INonfungiblePositionManager(p.npm).mint(mp);
        console2.log("SeedTokenId  :", tokenId);
    }

    /// @dev BootConfig from MarketParams + this script's demo timing/band constants. IDENTICAL
    ///      timings/caps/MIN_LIQUIDITY to Deploy._boot EXCEPT epoch + band are now env-configurable:
    ///      `EPOCH_DURATION` and `BAND_BPS` are read via vm.envOr, defaulting to the legacy demo
    ///      constants. So a deploy can emit the target 600s/20bps arena directly (set via env) while
    ///      an unset env keeps the legacy ETH path unchanged.
    function _boot(MarketParams memory p, address baseToken, address pool, address oracle)
        internal
        view
        returns (IFeeArena.BootConfig memory)
    {
        uint32 epochDuration = uint32(vm.envOr("EPOCH_DURATION", uint256(DEMO_EPOCH_DURATION)));
        int32 bandBps = int32(vm.envOr("BAND_BPS", int256(DEFAULT_BAND_BPS)));
        return IFeeArena.BootConfig({
            usdc: p.usdc,
            weth: baseToken,
            pool: pool,
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

    /// @notice Arc-testnet broadcast: deploy a second market reusing the shared V3 infra + USDC.
    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        MarketParams memory p = MarketParams({
            usdc: usdc(),
            npm: vm.envAddress("NPM_ADDRESS"),
            factory: vm.envAddress("FACTORY_ADDRESS"),
            swapRouter: vm.envOr("SWAP_ROUTER_ADDRESS", address(0)),
            owner: deployer,
            feeTier: feeTier(),
            minLiquidity: uint128(vm.envOr("MIN_LIQUIDITY", uint256(DEFAULT_MIN_LIQUIDITY))),
            feed: vm.envOr("MARKET_FEED", PYTH_BTC_USD),
            baseDecimals: uint8(vm.envOr("BASE_DECIMALS", uint256(8))),
            priceUsdc18: vm.envOr("INIT_PRICE_18", uint256(60_000e18)),
            seedBaseRaw: vm.envOr("SEED_BASE_RAW", uint256(0)),
            seedUsdcRaw: vm.envOr("SEED_USDC_RAW", uint256(0))
        });

        vm.startBroadcast(pk);
        d = deployMarket(p);

        // Optional: wire a least-privilege keeper (createEpoch/openEntry only) if provided.
        // Done inside the broadcast because the deployer EOA is the arena owner. If unset,
        // keeper stays address(0) and the owner runs the lifecycle itself.
        address keeperAddr = vm.envOr("KEEPER_ADDRESS", address(0));
        if (keeperAddr != address(0)) {
            FeeArena(payable(d.arena)).setKeeper(keeperAddr);
            console2.log("Keeper       :", keeperAddr);
        }

        vm.stopBroadcast();
    }
}
