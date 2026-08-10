// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Asserts the V3 pool init code hash that periphery embeds matches the
/// hash of the pool creation code we actually deploy. Mismatch => any
/// PoolAddress.computeAddress consumer would resolve the WRONG pool address.
/// FeeArena deliberately uses factory.getPool (not computeAddress) to sidestep
/// this hazard (must-fix #2); this test documents/locks the fork's hash anyway.
///
/// NOTE: this test is bytecode-only (no network), so it runs unconditionally even
/// though the filename ends `.fork.t.sol`.
contract PoolInitCodeHashTest is Test {
    // Canonical Uniswap V3 mainnet POOL_INIT_CODE_HASH. Our vendored pool does NOT
    // hash to this (different solc/metadata than mainnet), so the periphery constant
    // was patched to our recomputed value (see below) — this is kept only to document
    // the original mainnet value the fork diverges from.
    bytes32 internal constant MAINNET_INIT_CODE_HASH =
        0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;

    // The POOL_INIT_CODE_HASH constant now embedded in the (patched) vendored
    // periphery lib/v3-periphery/contracts/libraries/PoolAddress.sol. This MUST
    // equal keccak256(type(UniswapV3Pool).creationCode) for the pool we actually
    // compile, or NPM/SwapRouter would compute the wrong pool address and revert on
    // real swaps. If this assert fails after a solc/metadata change, recompute the
    // pool's creationCode hash and update BOTH this literal and the periphery
    // constant in lockstep. FeeArena validates pools via factory.getPool (immune to
    // this hash); the router path depends on it being right.
    bytes32 internal constant EXPECTED_INIT_CODE_HASH =
        0x47952758492516170790e3fc7847dc66f1339a1e8c995561b0d137b3f3e9abcd;

    function test_PoolCreationCodeHash_MatchesPeripheryEmbedded() public {
        // Pull the compiled pool creation bytecode by artifact name (forge resolves out/).
        bytes memory creationCode = vm.getCode("UniswapV3Pool.sol:UniswapV3Pool");
        assertGt(creationCode.length, 0, "UniswapV3Pool artifact not found; run forge build");

        bytes32 actual = keccak256(creationCode);
        console2.log("computed pool init code hash:");
        console2.logBytes32(actual);

        // The vendored periphery is a fork: its hash differs from mainnet's.
        assertTrue(actual != MAINNET_INIT_CODE_HASH, "expected fork hash to differ from mainnet");
        assertEq(actual, EXPECTED_INIT_CODE_HASH, "POOL_INIT_CODE_HASH mismatch: periphery is patched/forked");
    }
}
