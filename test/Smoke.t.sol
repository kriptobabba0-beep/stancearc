// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SmokeTarget} from "src/mocks/SmokeTarget.sol";

/// @dev Toolchain smoke test: proves (1) first-party ^0.8.20 code compiles,
///      (2) OZ Math.mulDiv (512-bit) is wired via remappings, (3) forge-std
///      Test harness runs, and (4) the floor-mulDiv contribution formula from
///      spec §4.1 behaves: 2 WETH @ $3000 -> 6000_000000 micro-USDC.
contract SmokeTest is Test {
    SmokeTarget internal target;

    // spec §4.1: WETH_NOTIONAL_DIV = 10**(18 + 18 - 6) = 1e30
    uint256 internal constant WETH_NOTIONAL_DIV = 1e30;

    function setUp() public {
        target = new SmokeTarget();
    }

    function test_Smoke_ToolchainCompilesAndRuns() public view {
        assertEq(target.ping(), 42, "SmokeTarget.ping must return 42");
    }

    function test_Smoke_MulDivFloorMatchesSpecExample() public pure {
        // 2 WETH (2e18) @ settlePrice18 = 3000e18, feeUSDC = 0
        uint256 feeWETH18 = 2e18;
        uint256 settlePrice18 = 3000e18;
        uint256 contribution6 = Math.mulDiv(feeWETH18, settlePrice18, WETH_NOTIONAL_DIV);
        assertEq(contribution6, 6000_000000, "2 WETH @ $3000 == 6000 micro-USDC (6dp)");
    }

    function testFuzz_Smoke_MulDivNeverExceedsExact(uint128 a, uint128 b) public pure {
        // floor invariant: mulDiv(a,b,d) * d <= a * b  (no over-credit)
        uint256 d = 1e30;
        uint256 q = Math.mulDiv(uint256(a), uint256(b), d);
        // q*d must not exceed a*b (floor); a,b are uint128 so a*b fits in uint256.
        assertLe(q * d, uint256(a) * uint256(b), "mulDiv must floor");
    }
}
