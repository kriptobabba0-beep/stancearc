// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {WETH9} from "src/mocks/WETH9.sol";

contract WETH9Test is Test {
    WETH9 internal weth;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        weth = new WETH9();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function test_DecimalsIs18() public view {
        assertEq(weth.decimals(), 18);
    }

    function test_NameAndSymbol() public view {
        assertEq(weth.name(), "Wrapped Ether");
        assertEq(weth.symbol(), "WETH");
    }

    function test_DepositMintsAndIncreasesSupply() public {
        vm.prank(alice);
        weth.deposit{value: 2 ether}();
        assertEq(weth.balanceOf(alice), 2 ether);
        assertEq(weth.totalSupply(), 2 ether);
        assertEq(address(weth).balance, 2 ether);
    }

    function test_ReceiveFallbackWraps() public {
        vm.prank(alice);
        (bool ok,) = address(weth).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(weth.balanceOf(alice), 1 ether);
    }

    function test_WithdrawBurnsAndReturnsEth() public {
        vm.startPrank(alice);
        weth.deposit{value: 5 ether}();
        uint256 ethBefore = alice.balance;
        weth.withdraw(2 ether);
        vm.stopPrank();
        assertEq(weth.balanceOf(alice), 3 ether);
        assertEq(weth.totalSupply(), 3 ether);
        assertEq(alice.balance, ethBefore + 2 ether);
    }

    function test_WithdrawMoreThanBalanceReverts() public {
        vm.startPrank(alice);
        weth.deposit{value: 1 ether}();
        vm.expectRevert();
        weth.withdraw(2 ether);
        vm.stopPrank();
    }

    function test_Transfer() public {
        vm.prank(alice);
        weth.deposit{value: 4 ether}();
        vm.prank(alice);
        assertTrue(weth.transfer(bob, 1 ether));
        assertEq(weth.balanceOf(alice), 3 ether);
        assertEq(weth.balanceOf(bob), 1 ether);
    }

    function test_ApproveAndTransferFrom() public {
        vm.prank(alice);
        weth.deposit{value: 4 ether}();
        vm.prank(alice);
        assertTrue(weth.approve(bob, 3 ether));
        assertEq(weth.allowance(alice, bob), 3 ether);
        vm.prank(bob);
        assertTrue(weth.transferFrom(alice, bob, 2 ether));
        assertEq(weth.balanceOf(bob), 2 ether);
        assertEq(weth.allowance(alice, bob), 1 ether);
    }

    function test_TransferFromInfiniteAllowanceNotDecremented() public {
        vm.prank(alice);
        weth.deposit{value: 4 ether}();
        vm.prank(alice);
        weth.approve(bob, type(uint256).max);
        vm.prank(bob);
        weth.transferFrom(alice, bob, 2 ether);
        assertEq(weth.allowance(alice, bob), type(uint256).max);
    }

    function test_TransferFromInsufficientAllowanceReverts() public {
        vm.prank(alice);
        weth.deposit{value: 4 ether}();
        vm.prank(alice);
        weth.approve(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert();
        weth.transferFrom(alice, bob, 2 ether);
    }
}
