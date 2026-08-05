// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Trivial first-party (^0.8.20) target used only to prove the toolchain
///      and remappings compile and link. Removed/replaced once real src/ code
///      lands; carries no project logic.
contract SmokeTarget {
    function ping() external pure returns (uint256) {
        return 42;
    }
}
