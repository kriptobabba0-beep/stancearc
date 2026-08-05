// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ISwapRouter - minimal local surface for the Uniswap V3 SwapRouter.
/// @notice Only `exactInputSingle` is needed, and only by the fork/integration test
///         harness to run REAL swaps that accrue fees on the pool. FeeArena core
///         never swaps. Kept on `^0.8.20` so the 0.8.x test side never imports the
///         `>=0.7.5` periphery interface. `ExactInputSingleParams` layout matches the
///         pinned periphery `ISwapRouter.ExactInputSingleParams` exactly.
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
