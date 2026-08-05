// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "src/interfaces/IPriceOracle.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title CompositePythOracle - IPriceOracle adapter for a CROSS rate built from two Pyth feeds.
/// @notice getPrice() returns numerator/denominator (e.g. BTC/EUR = (BTC/USD) / (EUR/USD)) normalized
///         to 18-dp. Used for the cirBTC/EURC arena so cirBTC is quoted in EUR (matching the EURC pool)
///         instead of USD. Implements the SAME IPriceOracle the arena/keeper/frontend already use, so
///         it is a drop-in oracle: the arena only calls getPrice()/update().
///
///         update(data) posts a SIGNED Pyth blob (which should carry BOTH feeds so getPrice() reads two
///         fresh prices) - same fee/refund handling as PythPriceOracle. A blob with only the numerator
///         still updates that feed; the denominator then reads its last on-chain value (Pyth's
///         getPriceUnsafe - staleness gating lives in FeeArena, single source).
contract CompositePythOracle is IPriceOracle {
    error ZeroPrice();
    error ExpoOutOfRange();
    error FeeTooLow();
    error RefundFailed();

    IPyth public immutable pyth;
    /// @notice The NUMERATOR feed (e.g. BTC/USD). price = numerator / denominator.
    bytes32 public immutable numeratorFeedId;
    /// @notice The DENOMINATOR feed (e.g. EUR/USD). Cross rate = numerator/denominator (e.g. BTC/EUR).
    bytes32 public immutable denominatorFeedId;

    constructor(address pyth_, bytes32 numeratorFeedId_, bytes32 denominatorFeedId_) {
        pyth = IPyth(pyth_);
        numeratorFeedId = numeratorFeedId_;
        denominatorFeedId = denominatorFeedId_;
    }

    /// @dev Identical fee/refund handling to PythPriceOracle. The caller should pass a blob that updates
    ///      BOTH feeds (Hermes can return one blob for multiple ids) so getPrice() is fully fresh.
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

    /// @notice The cross rate (numerator/denominator) in 18-dp, e.g. BTC/EUR. updatedAt = the OLDER of
    ///         the two feeds' publish times (the cross is only as fresh as its stalest leg).
    function getPrice() external view returns (uint256 price18, uint256 updatedAt) {
        PythStructs.Price memory num = pyth.getPriceUnsafe(numeratorFeedId);
        PythStructs.Price memory den = pyth.getPriceUnsafe(denominatorFeedId);
        if (num.price <= 0 || den.price <= 0) revert ZeroPrice();
        uint256 num18 = _to18(uint256(uint64(num.price)), num.expo);
        uint256 den18 = _to18(uint256(uint64(den.price)), den.expo);
        if (den18 == 0) revert ZeroPrice();
        // (num18 / 1e18) / (den18 / 1e18) * 1e18 == num18 * 1e18 / den18  → cross rate in 18-dp.
        price18 = (num18 * 1e18) / den18;
        if (price18 == 0) revert ZeroPrice();
        uint256 nt = uint256(num.publishTime);
        uint256 dt = uint256(den.publishTime);
        updatedAt = nt < dt ? nt : dt;
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
