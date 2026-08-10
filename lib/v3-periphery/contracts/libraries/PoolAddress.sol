// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/// @title Provides functions for deriving a pool address from the factory, tokens, and the fee
library PoolAddress {
    // FORK PATCH (Fee Arena V0): the canonical Uniswap V3 mainnet hash
    // (0xe34f199b...) only matches pools compiled with mainnet's exact
    // solc/metadata. Our vendored UniswapV3Pool compiles to a DIFFERENT
    // creationCode hash, so PoolAddress.computeAddress (used by NPM/SwapRouter
    // to locate pools) would resolve the WRONG address and revert on real swaps.
    // Repoint the constant to keccak256(type(UniswapV3Pool).creationCode) for OUR
    // compiled pool so periphery resolves the pool we actually deploy. Locked by
    // test/fork/PoolInitCodeHash.fork.t.sol. FeeArena itself validates pools via
    // factory.getPool (immune to this hash), so this only affects the router path.
    // V1 RE-PATCH (2026-06-05): the pool creationCode hash is metadata-sensitive —
    // adding the @pythnetwork/ remapping changed solc's metadata input and re-hashed
    // the pool, so this constant was updated to the new compiled value. If remappings
    // or compiler settings change again, recompute via the locking test above.
    bytes32 internal constant POOL_INIT_CODE_HASH = 0x47952758492516170790e3fc7847dc66f1339a1e8c995561b0d137b3f3e9abcd;

    /// @notice The identifying key of the pool
    struct PoolKey {
        address token0;
        address token1;
        uint24 fee;
    }

    /// @notice Returns PoolKey: the ordered tokens with the matched fee levels
    /// @param tokenA The first token of a pool, unsorted
    /// @param tokenB The second token of a pool, unsorted
    /// @param fee The fee level of the pool
    /// @return Poolkey The pool details with ordered token0 and token1 assignments
    function getPoolKey(
        address tokenA,
        address tokenB,
        uint24 fee
    ) internal pure returns (PoolKey memory) {
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);
        return PoolKey({token0: tokenA, token1: tokenB, fee: fee});
    }

    /// @notice Deterministically computes the pool address given the factory and PoolKey
    /// @param factory The Uniswap V3 factory contract address
    /// @param key The PoolKey
    /// @return pool The contract address of the V3 pool
    function computeAddress(address factory, PoolKey memory key) internal pure returns (address pool) {
        require(key.token0 < key.token1);
        pool = address(
            uint256(
                keccak256(
                    abi.encodePacked(
                        hex'ff',
                        factory,
                        keccak256(abi.encode(key.token0, key.token1, key.fee)),
                        POOL_INIT_CODE_HASH
                    )
                )
            )
        );
    }
}
