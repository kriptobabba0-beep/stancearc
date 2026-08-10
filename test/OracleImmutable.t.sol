// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";

contract OracleImmutableTest is FeeArenaTestBase {
    function test_no_setOracle_function_exists() public {
        // Low-level call with the setOracle(address) selector must fail (function absent).
        (bool ok,) = address(arena).call(abi.encodeWithSignature("setOracle(address)", address(0xdead)));
        assertFalse(ok, "setOracle must not exist on FeeArena");
    }

    function test_oracle_is_the_immutable_constructor_oracle() public view {
        assertEq(arena.ORACLE(), address(oracle));
    }
}
