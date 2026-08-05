// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "src/interfaces/IPriceOracle.sol";

/// @title IPinnedPriceOracle - protocol-pinned price read for FeeArena v2 (spec §HARDENING T1+T2).
/// @notice Extends {IPriceOracle} (so a v2 oracle is still a valid `getPrice` adapter for any
///         non-pinned read path / `IPriceOracle` sanity probe) with `getPinnedPrice`: a payable
///         read that forces the price publishTime into a NARROW [min,max] window chosen by the
///         CONTRACT (not the cranker), killing settle-price selection. It additionally surfaces
///         the Pyth confidence interval (18-dp) so the consumer can reject wide-confidence prints
///         (T2). All values are 18-dp (1e18 == $1) - the quote scale, unrelated to USDC's 6-dp.
interface IPinnedPriceOracle is IPriceOracle {
    /// @notice Parse a signed price update and return it ONLY if its publishTime falls in
    ///         [minPublishTime, maxPublishTime]; reverts otherwise (the underlying
    ///         pyth.parsePriceFeedUpdates enforces the window). Pays the update fee from
    ///         `msg.value`; the consumer refunds any excess.
    /// @param updateData     signed Pyth price update blob(s).
    /// @param minPublishTime minimum acceptable publishTime (inclusive).
    /// @param maxPublishTime maximum acceptable publishTime (inclusive).
    /// @return price18     pinned price scaled to 18 decimals (1e18 == $1), always > 0 when valid.
    /// @return conf18      confidence interval scaled to 18 decimals (same scale as price18).
    /// @return publishTime unix publishTime of the pinned update (in [min,max]).
    function getPinnedPrice(bytes[] calldata updateData, uint64 minPublishTime, uint64 maxPublishTime)
        external
        payable
        returns (uint256 price18, uint256 conf18, uint64 publishTime);
}
