// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "src/interfaces/IPriceOracle.sol";
import {IPinnedPriceOracle} from "src/interfaces/IPinnedPriceOracle.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockPriceOracle - V0 owner-set price oracle behind IPriceOracle / IPinnedPriceOracle.
/// @notice price18 is 18-dp (1e18 == $1). Admin controls the outcome in V0 (accepted risk,
///         spec line 520); per-epoch prices are snapshotted immutably and PriceSet is emitted.
///         V1 wires a Chainlink/Pyth/Stork adapter as the immutable FeeArena.ORACLE at deploy time.
///
///         Also implements {IPinnedPriceOracle.getPinnedPrice} (additive; v1 paths only use
///         getPrice/update) so the FeeArena v2 pinned-settle wiring (T1/T2) is testable WITHOUT a
///         live Pyth fork: getPinnedPrice REVERTS when the stamped publishTime is outside the
///         contract-chosen [min,max] window (mirroring parsePriceFeedUpdates), and returns an
///         owner-set confidence so the consumer's conf bound can be exercised.
contract MockPriceOracle is IPinnedPriceOracle, Ownable {
    /// @notice price18==0 rejected at the setter so FeeArena never reads a zero price.
    error ZeroPrice();
    /// @notice The stamped publishTime is outside [minPublishTime, maxPublishTime] (T1 pin).
    ///         Mirrors PythErrors.PriceFeedNotFoundWithinRange from parsePriceFeedUpdates.
    error OutOfWindow();

    event PriceSet(uint256 price18, uint256 updatedAt);
    event ConfSet(uint256 conf18);

    uint256 private _price18;
    uint256 private _conf18;
    uint256 private _updatedAt;

    constructor() Ownable() {}

    /// @notice Owner sets the 18-dp price; stamps block.timestamp as updatedAt (== pinned publishTime).
    function setPrice(uint256 price18) external onlyOwner {
        if (price18 == 0) revert ZeroPrice();
        _price18 = price18;
        _updatedAt = block.timestamp;
        emit PriceSet(price18, block.timestamp);
    }

    /// @notice Owner sets the 18-dp confidence interval surfaced by getPinnedPrice (default 0).
    function setConf(uint256 conf18) external onlyOwner {
        _conf18 = conf18;
        emit ConfSet(conf18);
    }

    /// @inheritdoc IPriceOracle
    function getPrice() external view returns (uint256 price18, uint256 updatedAt) {
        return (_price18, _updatedAt);
    }

    /// @inheritdoc IPriceOracle
    /// @dev No-op in V0 (push oracle); accepts value/data so the V1 pull-fee path is signature-stable.
    function update(bytes[] calldata) external payable {}

    /// @inheritdoc IPinnedPriceOracle
    /// @dev Window-pin simulation: revert if the stamped publishTime is outside [min,max]
    ///      (mirrors pyth.parsePriceFeedUpdates). Returns the owner-set price + conf (18-dp).
    function getPinnedPrice(bytes[] calldata, uint64 minPublishTime, uint64 maxPublishTime)
        external
        payable
        returns (uint256 price18, uint256 conf18, uint64 publishTime)
    {
        if (_price18 == 0) revert ZeroPrice();
        uint64 ts = uint64(_updatedAt);
        if (ts < minPublishTime || ts > maxPublishTime) revert OutOfWindow();
        return (_price18, _conf18, ts);
    }
}
