// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title INonfungiblePositionManager - minimal local surface used by FeeArena.
/// @notice Narrow subset of Uniswap V3's NPM: `factory()` (boot assert
///         FACTORY == NPM.factory() - must-fix #2), `positions()` (pool/liquidity
///         validation at stake), `collect()` (per-epoch fee baseline reset + sweep),
///         and `safeTransferFrom` (NFT escrow + return on unstake). Kept on
///         `^0.8.20` so first-party code avoids the `>=0.5.0` composite interface.
interface INonfungiblePositionManager {
    function factory() external view returns (address);

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    /// @dev Mint params + mint are only used by the fork/integration test harness to
    ///      create REAL V3 positions; FeeArena core never mints. Layout matches the
    ///      pinned periphery `NonfungiblePositionManager.MintParams` exactly.
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function ownerOf(uint256 tokenId) external view returns (address owner);

    function safeTransferFrom(address from, address to, uint256 tokenId) external;

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
}
