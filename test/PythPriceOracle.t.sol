// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythPriceOracle} from "src/oracles/PythPriceOracle.sol";

contract PythPriceOracleTest is Test {
    MockPyth internal pyth;
    PythPriceOracle internal oracle;
    bytes32 internal constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    function setUp() public {
        vm.warp(1_000_000);
        pyth = new MockPyth(60, 1); // validTimePeriod=60s, singleUpdateFee=1 wei
        oracle = new PythPriceOracle(address(pyth), ETH_USD);
    }

    // NOTE: Installed MockPyth v2.2.0 createPriceFeedUpdateData takes 7 params
    // (no prevPrice param). Adapted from the 8-arg template provided.
    // Signature: (bytes32 id, int64 price, uint64 conf, int32 expo,
    //             int64 emaPrice, uint64 emaConf, uint64 publishTime)
    function _post(int64 price, int32 expo, uint64 ts) internal {
        bytes[] memory data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(ETH_USD, price, 0, expo, price, 0, ts);
        uint256 fee = pyth.getUpdateFee(data);
        oracle.update{value: fee}(data);
    }

    function test_getPrice_normalizes_expo_neg8_to_18dp() public {
        _post(300000000000, -8, uint64(block.timestamp)); // $3000.00000000
        (uint256 price18, uint256 updatedAt) = oracle.getPrice();
        assertEq(price18, 3000e18, "3000 USD in 18dp");
        assertEq(updatedAt, block.timestamp);
    }

    function test_getPrice_normalizes_expo_neg5() public {
        _post(300000000, -5, uint64(block.timestamp));
        (uint256 price18,) = oracle.getPrice();
        assertEq(price18, 3000e18);
    }

    function test_getPrice_reverts_on_nonpositive_price() public {
        _post(int64(-1), -8, uint64(block.timestamp));
        vm.expectRevert(PythPriceOracle.ZeroPrice.selector);
        oracle.getPrice();
    }

    function test_update_empty_data_is_noop_and_refunds() public {
        bytes[] memory none = new bytes[](0);
        vm.deal(address(this), 1 ether);
        uint256 before = address(this).balance;
        oracle.update{value: 0.1 ether}(none);
        assertEq(address(this).balance, before, "full refund on no-op");
    }

    function test_update_refunds_excess_over_fee() public {
        bytes[] memory data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(ETH_USD, 300000000000, 0, -8, 300000000000, 0, uint64(block.timestamp));
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        uint256 before = address(this).balance;
        oracle.update{value: fee + 0.05 ether}(data);
        assertEq(address(this).balance, before - fee, "only the fee is consumed");
    }

    function test_update_reverts_when_fee_too_low() public {
        bytes[] memory data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(ETH_USD, 300000000000, 0, -8, 300000000000, 0, uint64(block.timestamp));
        vm.expectRevert(PythPriceOracle.FeeTooLow.selector);
        oracle.update{value: 0}(data);
    }

    receive() external payable {}
}
