// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPriceOracle - provider-agnostic price feed for Fee Arena.
/// @notice Price is ALWAYS 18 decimals: 1e18 == $1. This 18 is a QUOTE scale and is
///         unrelated to USDC's 6-dp token scale (spec §5.1). FeeArena/OutcomeResolver depend
///         only on this interface so V1 adapters (Chainlink/Pyth/Stork) are an address-swap.
interface IPriceOracle {
    /// @return price18  current price scaled to 18 decimals (1e18 == $1), always > 0 when valid.
    /// @return updatedAt unix timestamp of the last price update (for staleness checks).
    function getPrice() external view returns (uint256 price18, uint256 updatedAt);

    /// @notice Pulls/refreshes the price. No-op for V0 mock/push oracles; forwards the
    ///         pull-oracle update fee in V1. payable so the FeeArena crank signature is V1-stable.
    function update(bytes[] calldata data) external payable;
}
