// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @title OutcomeResolver
/// @notice Pure band-decision library. ONE computation yields both the winning
///         `Side` and the single-sourced signed `deltaBps` (emitted delta always
///         equals the decision delta - spec §5.2, must-fix #13).
/// @dev    Boundary & equality map to RANGE via strict comparisons:
///         deltaBps >  band  -> UP
///         deltaBps < -band  -> DOWN
///         otherwise         -> RANGE  (interior, exact ±band, and end==start).
library OutcomeResolver {
    /// @notice Basis-point denominator (band 150 == 1.5%).
    uint256 internal constant BPS = 10_000;

    /// @dev startPrice18 == 0 or endPrice18 == 0 at decide instant.
    error ZeroPrice();
    /// @dev bandBps <= 0 || bandBps >= 10000 (misconfig - must never silently resolve).
    error BandOutOfRange();

    /// @param startPrice18 epoch start price, 18-dp (1e18 == $1), must be > 0.
    /// @param endPrice18   settlement price, 18-dp, must be > 0.
    /// @param bandBps      per-epoch band in basis points, 0 < bandBps < 10000.
    /// @return side        UP / DOWN / RANGE - never NONE.
    /// @return deltaBps    signed move in bps: (end - start) * 10000 / start (truncated toward zero).
    function resolve(uint256 startPrice18, uint256 endPrice18, int32 bandBps)
        internal
        pure
        returns (IFeeArena.Side side, int256 deltaBps)
    {
        if (startPrice18 == 0 || endPrice18 == 0) revert ZeroPrice();
        if (bandBps <= 0 || bandBps >= int32(int256(BPS))) revert BandOutOfRange();

        // Single signed computation; safe to int256 for realistic price18 ranges (spec §5.2).
        int256 start = int256(startPrice18);
        int256 end = int256(endPrice18);
        deltaBps = (end - start) * int256(BPS) / start;

        int256 band = int256(bandBps);
        if (deltaBps > band) {
            side = IFeeArena.Side.UP;
        } else if (deltaBps < -band) {
            side = IFeeArena.Side.DOWN;
        } else {
            side = IFeeArena.Side.RANGE; // interior + both ±band boundaries + equality
        }
    }
}
