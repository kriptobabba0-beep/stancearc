// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IUniswapV3Pool - minimal local view surface used by FeeArena.
/// @notice Only the members FeeArena needs: token0/token1/fee (wethIsToken0
///         resolution at boot) and liquidity (MIN_LIQUIDITY validation at stake).
///         tickSpacing() is used by DeployMarket._seed to derive full-range ticks.
///         Kept narrow so first-party `^0.8.20` code never imports the full
///         `>=0.5.0` Uniswap composite interface.
interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function tickSpacing() external view returns (int24);
}
