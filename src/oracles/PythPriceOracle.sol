// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "src/interfaces/IPriceOracle.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title PythPriceOracle - IPriceOracle adapter over an arbitrary Pyth pull feed.
/// @notice getPrice() returns the latest posted Pyth price normalized to 18-dp + its
///         publishTime. Staleness/pinning live in FeeArena (single source). update() posts a
///         signed Pyth update paying the exact fee and refunding any excess to the caller.
///         The feed id is generic (ETH/USD, BTC/USD, …) so one oracle serves any market.
contract PythPriceOracle is IPriceOracle {
    error ZeroPrice();
    error ExpoOutOfRange();
    error FeeTooLow();
    error RefundFailed();

    IPyth public immutable pyth;
    /// @notice Pyth feed id this oracle reads (e.g. ETH/USD or BTC/USD). Generic - not ETH-specific.
    bytes32 public immutable feedId;

    constructor(address pyth_, bytes32 feedId_) {
        pyth = IPyth(pyth_);
        feedId = feedId_;
    }

    function update(bytes[] calldata data) external payable {
        if (data.length == 0) {
            if (msg.value > 0) _refund(msg.sender, msg.value);
            return;
        }
        uint256 fee = pyth.getUpdateFee(data);
        if (msg.value < fee) revert FeeTooLow();
        pyth.updatePriceFeeds{value: fee}(data);
        if (msg.value > fee) _refund(msg.sender, msg.value - fee);
    }

    function getPrice() external view returns (uint256 price18, uint256 updatedAt) {
        PythStructs.Price memory p = pyth.getPriceUnsafe(feedId);
        if (p.price <= 0) revert ZeroPrice();
        price18 = _to18(uint256(uint64(p.price)), p.expo);
        updatedAt = uint256(p.publishTime);
    }

    /// @dev price18 = rawPrice * 10**(18 + expo). expo is typically negative (e.g. -8).
    function _to18(uint256 rawPrice, int32 expo) internal pure returns (uint256) {
        int256 e = int256(18) + int256(expo);
        if (e < 0 || e > 36) revert ExpoOutOfRange();
        return rawPrice * (10 ** uint256(e));
    }

    function _refund(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert RefundFailed();
    }
}
