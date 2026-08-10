// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {CompositePythOracle} from "src/oracles/CompositePythOracle.sol";

contract CompositePythOracleTest is Test {
    MockPyth internal pyth;
    CompositePythOracle internal oracle;
    // BTC/USD (numerator) and EUR/USD (denominator) — cross = BTC/EUR.
    bytes32 internal constant BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant EUR_USD = 0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b;

    function setUp() public {
        vm.warp(1_000_000);
        pyth = new MockPyth(60, 1);
        oracle = new CompositePythOracle(address(pyth), BTC_USD, EUR_USD);
    }

    /// Post BOTH feeds in one blob (Hermes returns one blob for multiple ids).
    function _postBoth(int64 btc, int32 btcExpo, uint64 btcTs, int64 eur, int32 eurExpo, uint64 eurTs) internal {
        bytes[] memory data = new bytes[](2);
        data[0] = pyth.createPriceFeedUpdateData(BTC_USD, btc, 0, btcExpo, btc, 0, btcTs);
        data[1] = pyth.createPriceFeedUpdateData(EUR_USD, eur, 0, eurExpo, eur, 0, eurTs);
        uint256 fee = pyth.getUpdateFee(data);
        oracle.update{value: fee}(data);
    }

    function test_getPrice_returns_btc_per_eur_cross() public {
        // BTC/USD = $65,000 ; EUR/USD = 1.08  =>  BTC/EUR = 65000 / 1.08 ≈ 60,185.19
        _postBoth(6_500_000_000_000, -8, uint64(block.timestamp), 108_000_000, -8, uint64(block.timestamp));
        (uint256 price18,) = oracle.getPrice();
        uint256 expected = (uint256(65_000e18) * 1e18) / uint256(108e16); // 1.08e18
        assertEq(price18, expected, "BTC/EUR exact cross");
        assertGt(price18, 60_000e18, "sane lower bound");
        assertLt(price18, 60_500e18, "sane upper bound");
    }

    function test_getPrice_handles_mixed_exponents() public {
        // Same prices via different expos must give the same cross (decimals-generic _to18).
        _postBoth(650_000_000, -4, uint64(block.timestamp), 1_080_000, -6, uint64(block.timestamp)); // 65000 ; 1.08
        (uint256 price18,) = oracle.getPrice();
        assertApproxEqRel(price18, 60_185_185185185185185185, 1e12, "approx 60185.19 EUR per BTC");
    }

    function test_updatedAt_is_the_older_of_the_two_legs() public {
        _postBoth(6_500_000_000_000, -8, uint64(block.timestamp), 108_000_000, -8, uint64(block.timestamp - 5));
        (, uint256 updatedAt) = oracle.getPrice();
        assertEq(updatedAt, block.timestamp - 5, "cross is only as fresh as its stalest leg");
    }

    function test_reverts_on_nonpositive_leg() public {
        _postBoth(int64(-1), -8, uint64(block.timestamp), 108_000_000, -8, uint64(block.timestamp));
        vm.expectRevert(CompositePythOracle.ZeroPrice.selector);
        oracle.getPrice();
    }

    function test_update_empty_data_refunds() public {
        bytes[] memory none = new bytes[](0);
        vm.deal(address(this), 1 ether);
        uint256 before = address(this).balance;
        oracle.update{value: 0.1 ether}(none);
        assertEq(address(this).balance, before, "full refund on no-op");
    }

    receive() external payable {}
}
