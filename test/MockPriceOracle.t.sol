// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {IPriceOracle} from "src/interfaces/IPriceOracle.sol";

contract MockPriceOracleTest is Test {
    MockPriceOracle internal oracle;
    address internal owner = address(this);
    address internal stranger = makeAddr("stranger");

    // Mirror of the contract's event for vm.expectEmit.
    event PriceSet(uint256 price18, uint256 updatedAt);

    function setUp() public {
        oracle = new MockPriceOracle();
    }

    function test_OwnerIsDeployer() public view {
        assertEq(oracle.owner(), owner);
    }

    function test_SetPriceStoresAndStampsTimestamp() public {
        vm.warp(1_700_000_000);
        oracle.setPrice(3000e18);
        (uint256 p, uint256 ts) = oracle.getPrice();
        assertEq(p, 3000e18);
        assertEq(ts, 1_700_000_000);
    }

    function test_SetPriceEmitsPriceSet() public {
        vm.warp(1_700_000_500);
        vm.expectEmit(false, false, false, true, address(oracle));
        emit PriceSet(2500e18, 1_700_000_500);
        oracle.setPrice(2500e18);
    }

    function test_SetPriceZeroReverts() public {
        vm.expectRevert(MockPriceOracle.ZeroPrice.selector);
        oracle.setPrice(0);
    }

    function test_SetPriceNonOwnerReverts() public {
        vm.prank(stranger);
        vm.expectRevert("Ownable: caller is not the owner");
        oracle.setPrice(1e18);
    }

    function test_SetPriceUpdatesBothFieldsOnReset() public {
        vm.warp(1000);
        oracle.setPrice(1e18);
        vm.warp(2000);
        oracle.setPrice(4000e18);
        (uint256 p, uint256 ts) = oracle.getPrice();
        assertEq(p, 4000e18);
        assertEq(ts, 2000);
    }

    function test_UpdateIsNoOp() public {
        vm.warp(5000);
        oracle.setPrice(1234e18);
        bytes[] memory data = new bytes[](0);
        oracle.update(data); // must not revert, must not change state
        (uint256 p, uint256 ts) = oracle.getPrice();
        assertEq(p, 1234e18);
        assertEq(ts, 5000);
    }

    function test_UpdateAcceptsValueNoOp() public {
        bytes[] memory data = new bytes[](0);
        oracle.update{value: 1 wei}(data); // payable, still no-op
    }

    function test_ReachableViaInterface() public {
        oracle.setPrice(3210e18);
        IPriceOracle iface = IPriceOracle(address(oracle));
        (uint256 p,) = iface.getPrice();
        assertEq(p, 3210e18);
    }

    function test_InitialStateIsZero() public view {
        (uint256 p, uint256 ts) = oracle.getPrice();
        assertEq(p, 0);
        assertEq(ts, 0);
    }

    function testFuzz_SetPriceRoundTrips(uint256 price18, uint256 ts) public {
        price18 = bound(price18, 1, type(uint256).max);
        ts = bound(ts, 1, type(uint64).max);
        vm.warp(ts);
        oracle.setPrice(price18);
        (uint256 p, uint256 stamped) = oracle.getPrice();
        assertEq(p, price18);
        assertEq(stamped, ts);
    }

    function testFuzz_ZeroAlwaysReverts(uint256 ts) public {
        ts = bound(ts, 0, type(uint64).max);
        vm.warp(ts);
        vm.expectRevert(MockPriceOracle.ZeroPrice.selector);
        oracle.setPrice(0);
    }

    function testFuzz_LastWriteWins(uint256 first, uint256 second, uint256 t1, uint256 t2) public {
        first = bound(first, 1, type(uint128).max);
        second = bound(second, 1, type(uint128).max);
        t1 = bound(t1, 1, type(uint32).max);
        t2 = bound(t2, t1, type(uint64).max);
        vm.warp(t1);
        oracle.setPrice(first);
        vm.warp(t2);
        oracle.setPrice(second);
        (uint256 p, uint256 stamped) = oracle.getPrice();
        assertEq(p, second);
        assertEq(stamped, t2);
    }
}
