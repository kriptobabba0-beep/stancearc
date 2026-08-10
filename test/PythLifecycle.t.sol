// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {PythPriceOracle} from "src/oracles/PythPriceOracle.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

/// @notice Minimal contract caller with NO receive()/fallback — used to prove the
///         RefundFailed path: a contract that overpays AND cannot receive the native
///         refund reverts. EOAs are unaffected (this documents money-5).
contract NonReceivingCranker {
    function crank(FeeArena a, bytes[] calldata d) external payable {
        a.startEpoch{value: msg.value}(d);
    }
}

/// @title PythLifecycle — FeeArena lifecycle driven by the REAL PythPriceOracle over
///        Pyth's MockPyth, plus the fee-refund (value>0) coverage that the
///        value-keeping MockPriceOracle could only false-pass.
/// @dev Closes audit gaps tests-1 (refund path untested with value>0) and tests-2
///      (no real-Pyth integration / pinning / staleness reverts).
contract PythLifecycleTest is FeeArenaTestBase {
    MockPyth internal pyth;
    PythPriceOracle internal pythOracle;
    bytes32 internal constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    function setUp() public override {
        super.setUp();
        // Real Pyth oracle over a fresh MockPyth; reuse the inherited pool/factory/npm.
        pyth = new MockPyth(60, 1); // validTimePeriod=60s, singleUpdateFee=1 wei
        pythOracle = new PythPriceOracle(address(pyth), ETH_USD);
        IFeeArena.BootConfig memory c = _bootConfig();
        c.oracle = address(pythOracle);
        arena = new FeeArena(c);
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    /// @dev Build a single-feed Pyth update payload.
    ///      MockPyth v2.2.0 createPriceFeedUpdateData has 7 args (no prevPublishTime):
    ///      (bytes32 id, int64 price, uint64 conf, int32 expo, int64 emaPrice,
    ///       uint64 emaConf, uint64 publishTime).
    function _data(int64 price, int32 expo, uint64 ts) internal view returns (bytes[] memory d) {
        d = new bytes[](1);
        d[0] = pyth.createPriceFeedUpdateData(ETH_USD, price, 0, expo, price, 0, ts);
    }

    /// @dev create -> openEntry; returns the new epoch view for boundary timestamps.
    function _open() internal returns (uint64 id, IFeeArena.EpochView memory e) {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        e = arena.getEpoch(id);
    }

    // ---------------------------------------------------------------------
    // tests-2: real-Pyth lifecycle + pinning/staleness reverts
    // ---------------------------------------------------------------------

    /// 1. Full UP-win lifecycle driven entirely by real Pyth prices.
    function test_FullLifecycle_UpWin_RealPyth() public {
        (uint64 id, IFeeArena.EpochView memory e) = _open();

        // start at $3000 (publishTime = now, >= entryCloseTime once warped)
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        bytes[] memory startData = _data(300000000000, -8, uint64(block.timestamp)); // $3000.00000000
        uint256 startFee = pyth.getUpdateFee(startData);
        arena.startEpoch{value: startFee}(startData);
        assertEq(arena.getEpoch(id).startPrice18, 3000e18, "start price 3000e18");

        // end at $3060 (+2% > 1.5% band -> UP wins)
        IFeeArena.EpochView memory e2 = arena.getEpoch(id);
        vm.warp(uint256(e2.endTime));
        bytes[] memory endData = _data(306000000000, -8, uint64(block.timestamp)); // $3060.00000000
        uint256 endFee = pyth.getUpdateFee(endData);
        arena.endEpoch{value: endFee}(endData);

        IFeeArena.EpochView memory e3 = arena.getEpoch(id);
        assertEq(e3.settlePrice18, 3060e18, "settle price 3060e18");
        assertEq(uint8(e3.winningSide), uint8(IFeeArena.Side.UP), "UP wins");
    }

    /// 2. Pinning revert at start: posted publishTime < entryCloseTime -> StartPriceTooOld.
    function test_StartPriceTooOld_RealPyth() public {
        (, IFeeArena.EpochView memory e) = _open();

        // publishTime strictly before entryCloseTime; MockPyth stores it, getPriceUnsafe
        // then returns updatedAt = entryCloseTime-1 < entryCloseTime.
        bytes[] memory data = _data(300000000000, -8, uint64(e.entryCloseTime) - 1);
        uint256 fee = pyth.getUpdateFee(data);

        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        vm.expectRevert(IFeeArena.StartPriceTooOld.selector);
        arena.startEpoch{value: fee}(data);
    }

    /// 3. Pinning revert at settle: settle publishTime < endTime -> SettlePriceTooOld.
    function test_SettlePriceTooOld_RealPyth() public {
        (uint64 id, IFeeArena.EpochView memory e) = _open();

        // start normally (publishTime at entryClose -> valid)
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        bytes[] memory startData = _data(300000000000, -8, uint64(e.entryCloseTime));
        arena.startEpoch{value: pyth.getUpdateFee(startData)}(startData);

        // settle data with publishTime strictly before endTime
        IFeeArena.EpochView memory e2 = arena.getEpoch(id);
        bytes[] memory settleData = _data(306000000000, -8, uint64(e2.endTime) - 1);
        uint256 fee = pyth.getUpdateFee(settleData);

        vm.warp(uint256(e2.endTime));
        vm.expectRevert(IFeeArena.SettlePriceTooOld.selector);
        arena.endEpoch{value: fee}(settleData);
    }

    /// 4. Staleness revert: post a settle price, let it age past maxPriceAge, then end
    ///    with EMPTY data (no re-post) so getPrice reads the now-stale stored price.
    function test_StalePrice_RealPyth() public {
        (uint64 id, IFeeArena.EpochView memory e) = _open();

        // start normally
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        bytes[] memory startData = _data(300000000000, -8, uint64(e.entryCloseTime));
        arena.startEpoch{value: pyth.getUpdateFee(startData)}(startData);

        IFeeArena.EpochView memory e2 = arena.getEpoch(id);
        vm.warp(uint256(e2.endTime));

        // POST the settle price directly to pyth (publishTime = endTime), valid right now...
        bytes[] memory settleData = _data(306000000000, -8, uint64(e2.endTime));
        uint256 fee = pyth.getUpdateFee(settleData);
        vm.deal(address(this), fee);
        pyth.updatePriceFeeds{value: fee}(settleData);

        // ...then let it age beyond maxPriceAge and end with EMPTY data (no re-post).
        vm.warp(block.timestamp + MAX_PRICE_AGE + 1);
        vm.expectRevert(IFeeArena.StalePrice.selector);
        arena.endEpoch(new bytes[](0));
    }

    // ---------------------------------------------------------------------
    // tests-1: fee-refund path (value>0) via the REAL oracle wiring
    // ---------------------------------------------------------------------

    /// 5. Overpaid startEpoch: caller debited exactly the Pyth fee; no native stranded.
    function test_StartEpoch_RefundsExcess_NothingStranded() public {
        vm.deal(address(this), 1 ether);
        (, IFeeArena.EpochView memory e) = _open();
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);

        bytes[] memory data = _data(300000000000, -8, uint64(block.timestamp));
        uint256 fee = pyth.getUpdateFee(data);
        uint256 before = address(this).balance;

        arena.startEpoch{value: fee + 0.3 ether}(data);

        assertEq(address(this).balance, before - fee, "only the Pyth fee consumed");
        assertEq(address(arena).balance, 0, "no native stranded in arena");
        assertEq(address(pythOracle).balance, 0, "no native stranded in oracle");
    }

    /// 6. Same invariants for an overpaid endEpoch.
    function test_EndEpoch_RefundsExcess_NothingStranded() public {
        vm.deal(address(this), 1 ether);
        (uint64 id, IFeeArena.EpochView memory e) = _open();

        // start normally first
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        bytes[] memory startData = _data(300000000000, -8, uint64(block.timestamp));
        arena.startEpoch{value: pyth.getUpdateFee(startData)}(startData);

        IFeeArena.EpochView memory e2 = arena.getEpoch(id);
        vm.warp(uint256(e2.endTime));
        bytes[] memory endData = _data(306000000000, -8, uint64(block.timestamp));
        uint256 fee = pyth.getUpdateFee(endData);
        uint256 before = address(this).balance;

        arena.endEpoch{value: fee + 0.3 ether}(endData);

        assertEq(address(this).balance, before - fee, "only the Pyth fee consumed");
        assertEq(address(arena).balance, 0, "no native stranded in arena");
        assertEq(address(pythOracle).balance, 0, "no native stranded in oracle");
    }

    /// 7. RefundFailed negative test: a contract caller that overpays AND cannot receive
    ///    native reverts when the excess refund send fails. (money-5)
    function test_RefundFailed_WhenCallerCannotReceive() public {
        NonReceivingCranker helper = new NonReceivingCranker();
        vm.deal(address(helper), 1 ether);

        (, IFeeArena.EpochView memory e) = _open();
        vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);

        bytes[] memory data = _data(300000000000, -8, uint64(block.timestamp));
        uint256 fee = pyth.getUpdateFee(data);

        // value == fee + excess(>0): the excess refund to the non-receiving helper fails.
        vm.expectRevert(IFeeArena.RefundFailed.selector);
        helper.crank{value: fee + 0.1 ether}(arena, data);
    }

    receive() external payable {}
}
