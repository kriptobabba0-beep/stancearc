// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "src/interfaces/IPriceOracle.sol";
import {IPinnedPriceOracle} from "src/interfaces/IPinnedPriceOracle.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title PythPriceOracleV2 - pinned IPriceOracle adapter over an arbitrary Pyth pull feed.
/// @notice Adds the FeeArena v2 settlement-integrity read `getPinnedPrice` (spec §HARDENING
///         T1+T2) on top of the v1 `getPrice`/`update` surface:
///
///         - getPinnedPrice(updateData, minPublishTime, maxPublishTime): calls
///           pyth.parsePriceFeedUpdates{value:fee}(updateData, [feedId], min, max). That call
///           REVERTS unless the blob's publishTime is in [min,max], so the CONSUMER (FeeArena),
///           not the cranker, fixes the timestamp - the print can no longer be selected (T1).
///           It returns the price + confidence interval (both 18-dp) + publishTime so the
///           consumer can additionally enforce a confidence bound (T2). parsePriceFeedUpdates is
///           payable and does NOT store on-chain; excess fee is refunded to the caller.
///
///         The feed id is generic (ETH/USD, BTC/USD, …) so one oracle serves any market.
///         Staleness / band decisions live in FeeArena (single source).
contract PythPriceOracleV2 is IPinnedPriceOracle {
    error ZeroPrice();
    error ExpoOutOfRange();
    error FeeTooLow();
    error RefundFailed();

    IPyth public immutable pyth;
    /// @notice Pyth feed id this oracle reads (e.g. BTC/USD). Generic - not asset-specific.
    bytes32 public immutable feedId;

    constructor(address pyth_, bytes32 feedId_) {
        pyth = IPyth(pyth_);
        feedId = feedId_;
    }

    /// @inheritdoc IPriceOracle
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

    /// @inheritdoc IPriceOracle
    /// @dev Non-pinned latest read (belt-and-suspenders / IPriceOracle sanity probe). The
    ///      binding settle read is `getPinnedPrice`; this stays for the C4 proposeOracle probe
    ///      and any non-pinned path. Ignores confidence (the pinned read is what carries it).
    function getPrice() external view returns (uint256 price18, uint256 updatedAt) {
        PythStructs.Price memory p = pyth.getPriceUnsafe(feedId);
        if (p.price <= 0) revert ZeroPrice();
        price18 = _to18(uint256(uint64(p.price)), p.expo);
        updatedAt = uint256(p.publishTime);
    }

    /// @inheritdoc IPinnedPriceOracle
    /// @dev The whole T1 fix: parsePriceFeedUpdates reverts out-of-window, so FeeArena pins the
    ///      timestamp at the epoch boundary and the cranker can no longer choose a favorable
    ///      print. conf is normalized to the SAME 18-dp scale as price (same expo) so the
    ///      consumer's `conf*BPS <= price*maxConfBps` check is scale-consistent (T2).
    function getPinnedPrice(bytes[] calldata updateData, uint64 minPublishTime, uint64 maxPublishTime)
        external
        payable
        returns (uint256 price18, uint256 conf18, uint64 publishTime)
    {
        uint256 fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert FeeTooLow();

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;
        // Reverts (PriceFeedNotFoundWithinRange) unless the blob publishTime is in [min,max].
        PythStructs.PriceFeed[] memory feeds =
            pyth.parsePriceFeedUpdates{value: fee}(updateData, ids, minPublishTime, maxPublishTime);

        PythStructs.Price memory p = feeds[0].price;
        if (p.price <= 0) revert ZeroPrice();
        price18 = _to18(uint256(uint64(p.price)), p.expo);
        conf18 = _to18(uint256(p.conf), p.expo);
        publishTime = uint64(p.publishTime);

        if (msg.value > fee) _refund(msg.sender, msg.value - fee);
    }

    /// @dev value18 = raw * 10**(18 + expo). expo is typically negative (e.g. -8). Shared by
    ///      price and conf so both land on the identical 18-dp scale.
    function _to18(uint256 raw, int32 expo) internal pure returns (uint256) {
        int256 e = int256(18) + int256(expo);
        if (e < 0 || e > 36) revert ExpoOutOfRange();
        return raw * (10 ** uint256(e));
    }

    function _refund(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert RefundFailed();
    }
}
