// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DeployMocks} from "../../script/DeployMocks.s.sol";
import {WETH9} from "../../src/mocks/WETH9.sol";
import {MockPriceOracle} from "../../src/mocks/MockPriceOracle.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract DeployMocksTest is Test {
    DeployMocks internal script;
    address internal owner = makeAddr("owner");

    function setUp() public {
        script = new DeployMocks();
    }

    function test_DeployMocks_ReturnsWiredMocks() public {
        (address weth, address oracle) = script.deployMocks(owner, 3000e18);

        assertEq(WETH9(payable(weth)).decimals(), 18, "weth decimals");
        assertEq(WETH9(payable(weth)).symbol(), "WETH", "weth symbol");

        // oracle ownership handed to `owner`
        assertEq(Ownable(oracle).owner(), owner, "oracle owner");

        (uint256 price18, uint256 updatedAt) = MockPriceOracle(oracle).getPrice();
        assertEq(price18, 3000e18, "seeded price");
        assertGt(updatedAt, 0, "updatedAt set");

        // oracle owner can set price; non-owner cannot
        vm.prank(owner);
        MockPriceOracle(oracle).setPrice(3100e18);
        (uint256 p2,) = MockPriceOracle(oracle).getPrice();
        assertEq(p2, 3100e18, "owner re-set");

        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        MockPriceOracle(oracle).setPrice(1);
    }

    function test_DeployMocks_NoSeed_OwnerCanSeedLater() public {
        (, address oracle) = script.deployMocks(owner, 0);
        // unseeded -> price is 0
        (uint256 price18,) = MockPriceOracle(oracle).getPrice();
        assertEq(price18, 0, "unseeded price 0");
        // owner can seed afterwards
        vm.prank(owner);
        MockPriceOracle(oracle).setPrice(2500e18);
        (uint256 p2,) = MockPriceOracle(oracle).getPrice();
        assertEq(p2, 2500e18, "owner seeded later");
    }
}
