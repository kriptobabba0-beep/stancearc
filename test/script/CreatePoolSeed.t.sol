// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {CreatePool} from "../../script/CreatePool.s.sol";

/// @notice Decimal-correctness test for the pool-seed price encoder.
/// @dev The load-bearing bug this guards: `encodeSqrtPrice` used to hardcode the base unit at
///      1e18, so an 8-dp base token (cirBTC) was seeded 10^(18-8)=10^10 too high (or low,
///      depending on sort order). This test decodes the `sqrtPriceX96` produced by
///      `encodeSqrtPrice(.., baseDecimals)` back to the human 18-dp price and asserts it lands
///      within a tight tolerance of the requested price for baseDecimals in {6, 8, 18}.
///
///      Decode math (the SAME interpretation the pool uses):
///        sqrtPriceX96 = sqrt(token1_raw / token0_raw) * 2^96
///        => P_raw (token1 per token0, raw) = (sqrtPriceX96^2) / 2^192
///      Then convert raw->human-18-dp by applying the (baseDecimals vs 6) decimal gap and the
///      token sort order:
///        - if base < usdc:  token0=base, token1=USDC ->
///              priceUsdcPerBase18 = P_raw * 10^baseDecimals / 10^6 * 1e18  (USDC raw per base raw,
///              then scaled by the decimal counts back to a per-1-base 18-dp human number)
///        - else:            token0=USDC, token1=base ->
///              priceUsdcPerBase18 = (1 / P_raw) * 10^baseDecimals / 10^6 * 1e18
///      We avoid float by keeping the algebra in fixed-point integer ratios (see _decodePrice18).
contract CreatePoolSeedTest is Test {
    CreatePool internal script;

    // Sort-order inputs from the real cirBTC/USDC market (VERIFIED facts):
    //   USDC  (quote, 6dp, native) = 0x3600...0000
    //   cirBTC(base,  8dp)         = 0xf0C4...432BF
    // cirBTC > USDC, so token0 = USDC, token1 = cirBTC.
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant CIRBTC = 0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF;
    // A base token that sorts BELOW USDC (base < usdc), exercising the token0=base / token1=USDC
    // branch of the encoder — the orientation the cirBTC market does NOT hit. Any address strictly
    // below 0x3600... works; use a low sentinel.
    address internal constant LOW_BASE = 0x0000000000000000000000000000000000000001;

    function setUp() public {
        script = new CreatePool();
    }

    /// @dev Decode a `sqrtPriceX96` back to the human 18-dp USDC-per-base price, applying the
    ///      decimal gap (base vs USDC=6) and the token sort order. Mirrors the pool's price
    ///      interpretation. Kept in integer fixed-point: we form the price as an mulDiv to 18-dp.
    /// @param quote the SAME quote (USDC) address the encoder used for its `base < usdc` sort
    ///        comparison — so decode orients identically to encode regardless of the chosen base.
    function _decodePrice18(uint160 sqrtPriceX96, address base, address quote, uint8 baseDecimals)
        internal
        pure
        returns (uint256 price18)
    {
        // P_rawQ192 = token1_raw/token0_raw scaled by 2^192 == sqrtPriceX96^2 (exact, pre-divide).
        uint256 sp = uint256(sqrtPriceX96);
        uint256 pRawQ192 = sp * sp; // == (token1_raw/token0_raw) * 2^192

        // Decimal scaling 10^baseDecimals / 10^6 (base->USDC decimal gap) and the 1e18 human scale.
        uint256 baseUnit = 10 ** uint256(baseDecimals);
        uint256 usdcUnit = 1e6;

        if (base < quote) {
            // token0=base, token1=USDC: P_raw = usdcRaw/baseRaw.
            // usdcPerBase18 = P_raw * (baseUnit/usdcUnit) * 1e18
            //              = pRawQ192 / 2^192 * baseUnit / usdcUnit * 1e18
            // Order ops to keep precision: (pRawQ192 * baseUnit * 1e18) / (usdcUnit * 2^192)
            price18 = mulDiv(pRawQ192, baseUnit * 1e18, usdcUnit << 192);
        } else {
            // token0=USDC, token1=base: P_raw = baseRaw/usdcRaw, so usdc/base = 1/P_raw.
            // usdcPerBase18 = (1/P_raw) * (baseUnit/usdcUnit) * 1e18
            //              = (2^192 / pRawQ192) * baseUnit / usdcUnit * 1e18
            // = (2^192 * baseUnit * 1e18) / (pRawQ192 * usdcUnit)
            price18 = mulDiv(uint256(1) << 192, baseUnit * 1e18, pRawQ192 * usdcUnit);
        }
    }

    /// @dev 512-bit mulDiv (Remco Bloemen / OZ Math) so the 2^192 scaling never overflows.
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denominator > 0, "div0");
                return prod0 / denominator;
            }
            require(denominator > prod1, "mulDiv overflow");
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = prod0 * inverse;
        }
    }

    /// @dev Assert decode(encode(price)) ~= price within `bps` basis points (sqrt rounding only).
    function _assertRoundTrip(address base, address quote, uint256 price18, uint8 baseDecimals, uint256 bps)
        internal
        view
    {
        uint160 sp = script.encodeSqrtPrice(base, quote, price18, baseDecimals);
        assertGt(sp, 0, "sqrtPrice nonzero");
        // Decode with the SAME quote the encoder sorted against, so orientation matches for both
        // base>quote (cirBTC) and base<quote (LOW_BASE) cases.
        uint256 decoded = _decodePrice18(sp, base, quote, baseDecimals);
        uint256 tol = (price18 * bps) / 10_000;
        assertApproxEqAbs(decoded, price18, tol, "decoded price != requested (decimal mis-seed?)");
    }

    /// @notice 18-dp base (legacy WETH-style): $3000, must still round-trip (no regression).
    function test_RoundTrip_18dp() public view {
        // Use the cirBTC address slot purely as an 18-dp "base"; sort vs USDC is what matters.
        _assertRoundTrip(CIRBTC, USDC, 3000e18, 18, 1);
    }

    /// @notice 8-dp base (cirBTC) at a realistic BTC price — the case that used to mis-seed 10^10.
    function test_RoundTrip_8dp_cirBTC_61000() public view {
        _assertRoundTrip(CIRBTC, USDC, 61000e18, 8, 1);
    }

    /// @notice 6-dp base — round-trips too (decimal-agnostic encoder).
    function test_RoundTrip_6dp() public view {
        _assertRoundTrip(CIRBTC, USDC, 1500e18, 6, 1);
    }

    /// @notice base < usdc branch (token0=base, token1=USDC) — the orientation cirBTC does NOT hit.
    ///         An 8-dp base sorting BELOW USDC must round-trip within 1bps, proving the encoder's
    ///         `base < usdc` leg is decimal-correct too (not just the base>usdc cirBTC leg).
    function test_RoundTrip_8dp_BaseBelowUsdc() public view {
        // Guard the precondition this test exists to cover.
        assertLt(uint256(uint160(LOW_BASE)), uint256(uint160(USDC)), "LOW_BASE must sort below USDC for this branch");
        _assertRoundTrip(LOW_BASE, USDC, 61000e18, 8, 1);
    }

    /// @notice The base<usdc branch must also round-trip for an 18-dp base (no decimal regression on
    ///         the opposite sort orientation).
    function test_RoundTrip_18dp_BaseBelowUsdc() public view {
        assertLt(uint256(uint160(LOW_BASE)), uint256(uint160(USDC)), "LOW_BASE must sort below USDC for this branch");
        _assertRoundTrip(LOW_BASE, USDC, 3000e18, 18, 1);
    }

    /// @notice The regression guard, stated explicitly: the 8-dp seed must NOT differ from the
    ///         18-dp seed by ~10^10. We compare the decoded 8-dp price to the requested price and
    ///         assert it is NOT off by 10 orders of magnitude in EITHER direction.
    function test_8dp_DoesNotMisSeedBy1e10() public view {
        uint256 price18 = 61000e18;
        uint160 sp = script.encodeSqrtPrice(CIRBTC, USDC, price18, 8);
        uint256 decoded = _decodePrice18(sp, CIRBTC, USDC, 8);

        // If the old 1e18-hardcoded encoder were used with an 8-dp base, the decoded price would be
        // off by 10^(18-8)=10^10. Assert we are nowhere near that failure mode (within 2x is plenty).
        assertLt(decoded, price18 * 2, "decoded grossly too high (1e10 mis-seed)");
        assertGt(decoded, price18 / 2, "decoded grossly too low (1e10 mis-seed)");
    }

    /// @notice Both orderings of the same conceptual pair stay nonzero (orientation symmetry).
    function test_OrderIndependent_NonZero_8dp() public view {
        uint160 a = script.encodeSqrtPrice(CIRBTC, USDC, 61000e18, 8);
        uint160 b = script.encodeSqrtPrice(USDC, CIRBTC, 61000e18, 8);
        assertGt(a, 0, "base/usdc nonzero");
        assertGt(b, 0, "usdc/base nonzero");
    }
}
