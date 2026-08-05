// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IUniswapV3Factory} from "../src/interfaces/IUniswapV3Factory.sol";

/// @notice Minimal pool-init surface (the 0.7.6 pool's `initialize`), declared locally so this
///         0.8.x script never imports the >=0.5.0 Uniswap composite interface. Mirrors the
///         identical local interface used by `test/utils/V3Deployer.sol`.
interface IUniswapV3PoolInit {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/// @notice Creates + initializes the Arena WETH/USDC V3 pool at FEE_TIER.
/// @dev Uses `factory.createPool` + `pool.initialize(sqrtPriceX96)` (the path the local
///      `INonfungiblePositionManager` surface supports - it does NOT declare
///      `createAndInitializePoolIfNecessary`). `encodeSqrtPrice` derives the initial price
///      at runtime from the SORTED token addresses, so it is correct regardless of which
///      token sorts first (never a hardcoded constant). Idempotent: a second call returns
///      the existing pool and skips re-initialization.
contract CreatePool is Script {
    /// @notice Derive `sqrtPriceX96` (token1/token0 of the SORTED pair) for an 18-dp base token.
    ///         Back-compat overload of {encodeSqrtPrice}; equivalent to passing `baseDecimals = 18`.
    /// @param base  base (non-USDC) token address - assumed 18 dp on this overload (e.g. WETH9)
    /// @param usdc  USDC token address (6 dp)
    /// @param priceBaseInUsdc18 USDC per 1 base token, 18-dp (e.g. 3000e18 == $3000)
    function encodeSqrtPrice(address base, address usdc, uint256 priceBaseInUsdc18) public pure returns (uint160) {
        return encodeSqrtPrice(base, usdc, priceBaseInUsdc18, 18);
    }

    /// @notice Derive `sqrtPriceX96` (token1/token0 of the SORTED pair) for `priceBaseInUsdc18`
    ///         USDC-per-base (18-dp human price), honoring the base token's decimals. Correct for
    ///         either token ordering.
    /// @dev LOAD-BEARING decimal fix: the base raw unit is `10**baseDecimals`, NOT a hardcoded 1e18.
    ///      With the old hardcode an 8-dp base (e.g. cirBTC) was mis-seeded by 10^(18-8)=10^10. The
    ///      USDC leg stays 6-dp (`priceBaseInUsdc18 / 1e12`).
    /// @param base  base (non-USDC) token address
    /// @param usdc  USDC token address (6 dp)
    /// @param priceBaseInUsdc18 USDC per 1 base token, 18-dp (e.g. 61000e18 == $61,000)
    /// @param baseDecimals decimals of the base token (e.g. 8 for cirBTC/WBTC, 18 for WETH)
    function encodeSqrtPrice(address base, address usdc, uint256 priceBaseInUsdc18, uint8 baseDecimals)
        public
        pure
        returns (uint160)
    {
        require(priceBaseInUsdc18 > 0, "price=0");
        // USDC raw amount for `priceBaseInUsdc18` USDC: price18 * 1e6 / 1e18 == price18 / 1e12.
        uint256 usdcRaw = priceBaseInUsdc18 / 1e12;
        require(usdcRaw > 0, "price too small");
        uint256 baseRaw = 10 ** uint256(baseDecimals); // raw amount for 1.0 base token (decimal-aware)

        // price = token1_raw / token0_raw. Orient by sorted address ordering.
        uint256 num;
        uint256 den;
        if (base < usdc) {
            // token0 = base, token1 = USDC(6): price = usdcRaw / baseRaw
            num = usdcRaw;
            den = baseRaw;
        } else {
            // token0 = USDC(6), token1 = base: price = baseRaw / usdcRaw
            num = baseRaw;
            den = usdcRaw;
        }

        // sqrtPriceX96 = sqrt(price) * 2^96 = sqrt(price * 2^192). Compute (num<<192)/den then isqrt.
        uint256 ratioX192 = (num << 192) / den;
        uint256 sp = _sqrt(ratioX192);
        require(sp <= type(uint160).max, "sqrt overflow");
        return uint160(sp);
    }

    /// @notice Create + initialize the (sorted) WETH/USDC pool at `fee`. Idempotent: returns the
    ///         existing pool (no revert) on a second call.
    /// @param npm position manager address (unused by this path; kept for call-site symmetry)
    function createPool(address factory, address npm, address weth, address usdc, uint24 fee, uint160 sqrtPriceX96)
        public
        returns (address pool)
    {
        npm; // silence unused (signature symmetry with Deploy/plan)
        (address token0, address token1) = weth < usdc ? (weth, usdc) : (usdc, weth);

        pool = IUniswapV3Factory(factory).getPool(token0, token1, fee);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(factory).createPool(token0, token1, fee);
            require(pool != address(0), "createPool failed");
            IUniswapV3PoolInit(pool).initialize(sqrtPriceX96);
        }
        return pool;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function run() external returns (address pool) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address factory = vm.envAddress("FACTORY_ADDRESS");
        address npm = vm.envOr("NPM_ADDRESS", address(0));
        address weth = vm.envAddress("WETH_ADDRESS");
        address usdc = vm.envOr("USDC_ADDRESS", 0x3600000000000000000000000000000000000000);
        uint24 fee = uint24(vm.envOr("FEE_TIER", uint256(3000)));
        uint256 initPrice = vm.envOr("INIT_PRICE_18", uint256(3000e18));
        uint8 baseDecimals = uint8(vm.envOr("BASE_DECIMALS", uint256(18)));
        uint160 sp = encodeSqrtPrice(weth, usdc, initPrice, baseDecimals);
        vm.startBroadcast(pk);
        pool = createPool(factory, npm, weth, usdc, fee, sp);
        vm.stopBroadcast();
        console2.log("Pool         :", pool);
    }
}
