// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";

contract TestERC20Test is Test {
    TestERC20 internal usdc;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        // USDC double: 6 decimals, mirrors real testnet ERC-20 USDC at 0x3600...
        usdc = new TestERC20("USD Coin", "USDC", 6);
    }

    function test_ConfigurableDecimals6() public view {
        assertEq(usdc.decimals(), 6);
    }

    function test_DecimalsCanBe18() public {
        TestERC20 t = new TestERC20("Dai", "DAI", 18);
        assertEq(t.decimals(), 18);
    }

    function test_NameAndSymbol() public view {
        assertEq(usdc.name(), "USD Coin");
        assertEq(usdc.symbol(), "USDC");
    }

    function test_MintIncreasesBalanceAndSupply() public {
        usdc.mint(alice, 1_000_000); // 1.0 USDC at 6dp
        assertEq(usdc.balanceOf(alice), 1_000_000);
        assertEq(usdc.totalSupply(), 1_000_000);
    }

    function test_Transfer() public {
        usdc.mint(alice, 5_000_000);
        vm.prank(alice);
        assertTrue(usdc.transfer(bob, 2_000_000));
        assertEq(usdc.balanceOf(alice), 3_000_000);
        assertEq(usdc.balanceOf(bob), 2_000_000);
    }

    function test_ApproveAndTransferFrom() public {
        usdc.mint(alice, 5_000_000);
        vm.prank(alice);
        assertTrue(usdc.approve(bob, 3_000_000));
        assertEq(usdc.allowance(alice, bob), 3_000_000);
        vm.prank(bob);
        assertTrue(usdc.transferFrom(alice, bob, 2_000_000));
        assertEq(usdc.balanceOf(bob), 2_000_000);
        assertEq(usdc.allowance(alice, bob), 1_000_000);
    }

    function test_TransferInsufficientBalanceReverts() public {
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        vm.expectRevert();
        usdc.transfer(bob, 2_000_000);
    }
}
