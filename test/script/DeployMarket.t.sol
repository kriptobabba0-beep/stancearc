// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DeployMarket} from "../../script/DeployMarket.s.sol";
import {Config} from "../../script/config/Config.sol";
import {V3Deployer} from "../utils/V3Deployer.sol";
import {WETH9} from "../../src/mocks/WETH9.sol";
import {TestERC20} from "../../src/mocks/TestERC20.sol";
import {MockWBTC} from "../../src/mocks/MockWBTC.sol";
import {FeeArena} from "../../src/FeeArena.sol";
import {IFeeArena} from "../../src/interfaces/IFeeArena.sol";
import {PythPriceOracle} from "../../src/oracles/PythPriceOracle.sol";
import {IUniswapV3Pool} from "../../src/interfaces/IUniswapV3Pool.sol";
import {CreatePool} from "../../script/CreatePool.s.sol";

/// @dev Minimal `slot0` surface (the deployed 0.7.6 pool's storage read) so we can assert the
///      seeded `sqrtPriceX96` matches the decimal-correct encode. The project's `IUniswapV3Pool`
///      surface intentionally omits slot0; we declare just what we need locally.
interface IPoolSlot0 {
    function slot0() external view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool);
}

/// @notice No-network sim for {DeployMarket}. Deploys the shared V3 infra (like DeployTest), a
///         6-dp MOCK USDC (Arc's real USDC calls a compliance precompile forge/revm can't run, so
///         we use a mock double in-sim — same pattern as Deploy/DeployUsePyth), then drives
///         {DeployMarket.deployMarket} for a BTC/USDC market and asserts the wiring.
/// @dev Post-anti-manipulation, FeeArena's boot ALLOWS any non-USDC leg decimals (8-dp WBTC
///      binds directly). USDC must still be 6-dp. Seeding is left to the broadcast path (skipped
///      in-sim): the decimals/oracle/binding assertions don't need pool liquidity.
contract DeployMarketTest is Test {
    DeployMarket internal script;

    address internal owner = makeAddr("owner");
    address internal usdc;
    address internal weth; // shared infra needs a WETH9 for the V3 NPM/router ctors
    address internal factory;
    address internal npm;
    uint24 internal constant FEE = 3000;
    uint256 internal constant BTC_PRICE_18 = 60_000e18;

    function setUp() public {
        script = new DeployMarket();
        // Shared infra exactly as Deploy/DeployUsePyth set it up: WETH9 + V3 fork + mock USDC.
        weth = address(new WETH9());
        usdc = address(new TestERC20("USD Coin", "USDC", 6));
        V3Deployer.V3 memory v3 = V3Deployer.deploy(weth);
        factory = address(v3.factory);
        npm = address(v3.npm);
    }

    function _params(uint8 baseDecimals, bytes32 feed) internal view returns (DeployMarket.MarketParams memory) {
        return DeployMarket.MarketParams({
            usdc: usdc,
            npm: npm,
            factory: factory,
            swapRouter: address(0),
            owner: owner,
            feeTier: FEE,
            minLiquidity: uint128(Config(address(script)).DEFAULT_MIN_LIQUIDITY()),
            feed: feed,
            baseDecimals: baseDecimals,
            priceUsdc18: BTC_PRICE_18,
            seedBaseRaw: 0, // skip live seed in-sim (real-USDC precompile can't run in forge)
            seedUsdcRaw: 0
        });
    }

    /// @notice Core: a BTC/USDC market binds FeeArena to the new base/USDC pool + a BTC Pyth oracle.
    ///         8-dp base (MockWBTC) now binds directly — the vestigial 18-dp constraint is gone.
    function test_DeployMarket_WiresBtcMarket() public {
        bytes32 feed = Config(address(script)).PYTH_BTC_USD();
        DeployMarket.Deployed memory d = script.deployMarket(_params(8, feed));

        FeeArena arena = FeeArena(payable(d.arena));

        // FeeArena's pool is the NEW base/USDC pool, and USDC leg is the shared USDC.
        assertEq(arena.POOL(), d.pool, "arena bound to new base/USDC pool");
        assertEq(arena.WETH(), d.baseToken, "arena base leg is the new base token");
        assertEq(arena.USDC(), usdc, "arena reuses shared USDC");
        assertEq(arena.NPM(), npm, "arena reuses shared NPM");
        assertEq(arena.FACTORY(), factory, "arena reuses shared factory");
        assertEq(arena.owner(), owner, "owner wired");

        // The pool created is the base/USDC pair (token0/token1 are exactly {base, usdc}).
        address t0 = IUniswapV3Pool(d.pool).token0();
        address t1 = IUniswapV3Pool(d.pool).token1();
        assertTrue((t0 == d.baseToken && t1 == usdc) || (t0 == usdc && t1 == d.baseToken), "pool is base/USDC pair");

        // ORACLE is a PythPriceOracle wired to Arc Pyth + the BTC/USD feed (generic feedId).
        PythPriceOracle oracle = PythPriceOracle(arena.ORACLE());
        assertEq(address(oracle.pyth()), Config(address(script)).PYTH(), "pyth contract wired");
        assertEq(oracle.feedId(), feed, "BTC/USD feed id wired");

        // 8-dp base: MockWBTC deployed, pool is base/USDC, base decimals == 8.
        assertEq(uint256(MockWBTC(d.baseToken).decimals()), 8, "base decimals == 8");
    }

    /// @notice MockWBTC mirrors real WBTC at 8 decimals (the demo base token for the BTC leg).
    function test_MockWBTC_Has8Decimals() public {
        MockWBTC wbtc = new MockWBTC();
        assertEq(uint256(wbtc.decimals()), 8, "WBTC is 8-dp");
        assertEq(wbtc.symbol(), "WBTC", "symbol");
    }

    /// @notice Post-anti-manipulation: an 8-dp non-USDC leg (MockWBTC) deploys and binds
    ///         successfully. FeeArena now only hard-requires USDC to be 6-dp; the base token
    ///         may have any decimals. WETH_NOTIONAL_DIV for 8-dp base = 10**(8+18-6) = 10**20.
    function test_DeployMarket_8dpBaseToken_BindsSuccessfully() public {
        bytes32 feed = Config(address(script)).PYTH_BTC_USD();
        DeployMarket.Deployed memory d = script.deployMarket(_params(8, feed));

        FeeArena arena = FeeArena(payable(d.arena));
        assertEq(arena.ORACLE(), d.oracle, "PythPriceOracle wired");
        // pool is base/USDC; verify it's the right pair
        address t0 = IUniswapV3Pool(d.pool).token0();
        address t1 = IUniswapV3Pool(d.pool).token1();
        assertTrue((t0 == d.baseToken && t1 == usdc) || (t0 == usdc && t1 == d.baseToken), "pool is base/USDC pair");
        assertEq(uint256(MockWBTC(d.baseToken).decimals()), 8, "base decimals == 8");
    }

    /// @notice ON-CHAIN DECIMALS (deterministic, no env): `_baseDecimals` returns the token's actual
    ///         on-chain `decimals()` (MockWBTC == 8) even when handed a WRONG fallback (18), and uses
    ///         the fallback only when the token has no `decimals()` (an EOA-like address with no code).
    function test_DeployMarket_BaseDecimals_OnChainWinsOverFallback() public {
        DeployMarketHarness h = new DeployMarketHarness();
        MockWBTC wbtc = new MockWBTC(); // real 8-dp token
        // On-chain decimals (8) override the deliberately-wrong fallback (18) -> no 10^10 mis-seed.
        assertEq(uint256(h.baseDecimals(address(wbtc), 18)), 8, "on-chain decimals(8) win over fallback");
        // No decimals() at the address -> fall back to the supplied value (try/catch path).
        assertEq(uint256(h.baseDecimals(address(0xDEAD), 18)), 18, "fallback used when decimals() absent");
    }

    /// @notice ON-CHAIN DECIMALS (integration): the normal BTC market seeds the pool with the base
    ///         token's ACTUAL on-chain decimals (MockWBTC == 8). The seeded `sqrtPriceX96` must equal
    ///         the decimal-correct 8-dp encode and must NOT equal the 18-dp (10^10 mis-seed) encode.
    ///         No env mutation — `_makePool` derives decimals from the deployed token via decimals().
    function test_DeployMarket_SeedUsesOnChainDecimals() public {
        bytes32 feed = Config(address(script)).PYTH_BTC_USD();
        DeployMarket.Deployed memory d = script.deployMarket(_params(8, feed));

        (uint160 seeded,,,,,,) = IPoolSlot0(d.pool).slot0();

        // Decimal-correct expected price uses the ACTUAL 8 on-chain decimals.
        CreatePool pools = new CreatePool();
        uint160 expected8 = pools.encodeSqrtPrice(d.baseToken, usdc, BTC_PRICE_18, 8);
        // The WRONG 18-dp encode would differ by ~10^5 in sqrt space (10^10 in price).
        uint160 wrong18 = pools.encodeSqrtPrice(d.baseToken, usdc, BTC_PRICE_18, 18);

        assertEq(uint256(seeded), uint256(expected8), "pool seeded with on-chain (8-dp) decimals");
        assertTrue(seeded != wrong18, "pool NOT seeded with the 18-dp (10^10 mis-seed) encode");
    }

    /// @notice ARENA CONFIG REACHABLE — DEFAULTS: with `EPOCH_DURATION`/`BAND_BPS` unset, `_boot`
    ///         falls back to the legacy demo constants (300s / 150bps). Deterministic — uses NO env
    ///         mutation (forge parallelizes tests, so a `vm.setEnv` on these keys would race the
    ///         sibling default-reading suites). The env-OVERRIDE branch is exercised by the RUN-time
    ///         deploy (set EPOCH_DURATION/BAND_BPS in the environment); asserting it here would force
    ///         a process-global env write that races Deploy.t.sol's demo-default assertions.
    function test_DeployMarket_BootConfig_DefaultsWhenUnset() public {
        DeployMarketHarness h = new DeployMarketHarness();
        IFeeArena.BootConfig memory c = h.bootConfig(_params(8, Config(address(script)).PYTH_BTC_USD()));
        assertEq(
            uint256(c.epochDuration),
            uint256(Config(address(script)).DEMO_EPOCH_DURATION()),
            "epoch defaults to DEMO_EPOCH_DURATION"
        );
        assertEq(
            int256(c.bandBps), int256(Config(address(script)).DEFAULT_BAND_BPS()), "band defaults to DEFAULT_BAND_BPS"
        );
        // The remaining timing/cap fields are demo-fixed (not env-driven) — guard they're unchanged.
        assertEq(
            uint256(c.entryWindow), uint256(Config(address(script)).DEMO_ENTRY_WINDOW()), "entryWindow stays demo-fixed"
        );
        assertEq(c.minLiquidity, uint128(Config(address(script)).DEFAULT_MIN_LIQUIDITY()), "minLiquidity wired");
    }
}

/// @dev Test-only harness exposing {DeployMarket._boot} (internal) so the env-config wiring can be
///      asserted on the returned BootConfig struct directly — no full arena deploy, no live FeeArena.
///      `_boot` reads `EPOCH_DURATION`/`BAND_BPS` via vm.envOr exactly as the production path does.
contract DeployMarketHarness is DeployMarket {
    /// @notice Build the BootConfig the production deploy would pass to `new FeeArena(...)`. Base/
    ///         pool/oracle are placeholders — only the env-driven timing/band fields are under test.
    function bootConfig(MarketParams memory p) external view returns (IFeeArena.BootConfig memory) {
        return _boot(p, address(0xBA5E), address(0x9001), address(0x04AC));
    }

    /// @notice Expose the on-chain decimals derivation: returns the token's `decimals()` if exposed,
    ///         else `fallbackDecimals`. Lets a test assert the on-chain value wins deterministically.
    function baseDecimals(address token, uint8 fallbackDecimals) external view returns (uint8) {
        return _baseDecimals(token, fallbackDecimals);
    }
}
