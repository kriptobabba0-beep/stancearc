// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IUniswapV3Factory - minimal local view surface used by FeeArena.
/// @notice Only `getPool` is needed: pool validation reads the canonical pool
///         for (token0, token1, fee) and requires it == POOL (robust, avoids the
///         init-code-hash porting hazard - spec §3.1 / must-fix #2).
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);

    /// @dev createPool/enableFeeAmount are used only by the fork/integration test
    ///      harness to spin up REAL pools (and a wrong-fee-tier pool for the
    ///      validation-reject test). FeeArena core never creates pools.
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);

    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
}
