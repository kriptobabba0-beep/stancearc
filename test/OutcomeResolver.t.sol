// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {OutcomeResolver} from "src/libraries/OutcomeResolver.sol";

/// @dev Thin harness so we can call the `internal pure` library from tests.
contract ResolverHarness {
    function resolve(uint256 startPrice18, uint256 endPrice18, int32 bandBps)
        external
        pure
        returns (IFeeArena.Side side, int256 deltaBps)
    {
        return OutcomeResolver.resolve(startPrice18, endPrice18, bandBps);
    }
}

contract OutcomeResolverTest is Test {
    ResolverHarness internal h;

    int32 internal constant BAND = 150; // 1.5% default band
    uint256 internal constant START = 3000e18; // $3000 anchor

    function setUp() public {
        h = new ResolverHarness();
    }

    // ---- UP: strictly above +band ----
    function test_Resolve_UpAboveBand() public {
        // +151 bps move: 3000 * (1 + 0.0151) = 3045.3
        (IFeeArena.Side side, int256 delta) = h.resolve(START, 3045_300000000000000000, BAND);
        assertEq(uint8(side), uint8(IFeeArena.Side.UP), "side should be UP");
        assertEq(delta, int256(151), "delta should be +151");
    }

    // ---- DOWN: strictly below -band ----
    function test_Resolve_DownBelowBand() public {
        // -151 bps move: 3000 * (1 - 0.0151) = 2954.7
        (IFeeArena.Side side, int256 delta) = h.resolve(START, 2954_700000000000000000, BAND);
        assertEq(uint8(side), uint8(IFeeArena.Side.DOWN), "side should be DOWN");
        assertEq(delta, int256(-151), "delta should be -151");
    }

    // ---- RANGE: exact +band boundary ----
    function test_Resolve_ExactPlusBandIsRange() public {
        (IFeeArena.Side side, int256 delta) = h.resolve(START, 3045e18, BAND);
        assertEq(uint8(side), uint8(IFeeArena.Side.RANGE), "exact +band -> RANGE");
        assertEq(delta, int256(150), "delta should be +150");
    }

    // ---- RANGE: exact -band boundary ----
    function test_Resolve_ExactMinusBandIsRange() public {
        (IFeeArena.Side side, int256 delta) = h.resolve(START, 2955e18, BAND);
        assertEq(uint8(side), uint8(IFeeArena.Side.RANGE), "exact -band -> RANGE");
        assertEq(delta, int256(-150), "delta should be -150");
    }

    // ---- RANGE: interior 0 / +50 / -50 ----
    function test_Resolve_InteriorIsRange() public {
        (IFeeArena.Side s0, int256 d0) = h.resolve(START, START, BAND);
        assertEq(uint8(s0), uint8(IFeeArena.Side.RANGE), "0 -> RANGE");
        assertEq(d0, int256(0), "delta 0");

        (IFeeArena.Side sUp, int256 dUp) = h.resolve(START, 3015e18, BAND);
        assertEq(uint8(sUp), uint8(IFeeArena.Side.RANGE), "+50 -> RANGE");
        assertEq(dUp, int256(50), "delta +50");

        (IFeeArena.Side sDn, int256 dDn) = h.resolve(START, 2985e18, BAND);
        assertEq(uint8(sDn), uint8(IFeeArena.Side.RANGE), "-50 -> RANGE");
        assertEq(dDn, int256(-50), "delta -50");
    }

    // ---- end == start -> RANGE, delta 0 ----
    function test_Resolve_EndEqualsStartIsRange() public {
        (IFeeArena.Side side, int256 delta) = h.resolve(7777e18, 7777e18, BAND);
        assertEq(uint8(side), uint8(IFeeArena.Side.RANGE), "equality -> RANGE");
        assertEq(delta, int256(0), "delta 0 on equality");
    }

    // ---- single-sourced delta: the returned delta MUST justify the decision ----
    function test_Resolve_DeltaIsSingleSourced() public {
        (IFeeArena.Side side, int256 delta) = h.resolve(START, 3300e18, BAND); // +1000 bps
        assertEq(uint8(side), uint8(IFeeArena.Side.UP), "big up -> UP");
        assertEq(delta, int256(1000), "delta +1000");
        // Re-derive independently and require equality with the emitted delta.
        int256 expected = (int256(uint256(3300e18)) - int256(START)) * int256(10000) / int256(START);
        assertEq(delta, expected, "delta must equal the band-decision delta");
    }

    // ---- reverts: zero prices ----
    function test_Resolve_RevertWhen_StartZero() public {
        vm.expectRevert(OutcomeResolver.ZeroPrice.selector);
        h.resolve(0, 3000e18, BAND);
    }

    function test_Resolve_RevertWhen_EndZero() public {
        vm.expectRevert(OutcomeResolver.ZeroPrice.selector);
        h.resolve(3000e18, 0, BAND);
    }

    // ---- reverts: band out of range ----
    function test_Resolve_RevertWhen_BandZeroOrNegative() public {
        vm.expectRevert(OutcomeResolver.BandOutOfRange.selector);
        h.resolve(START, 3045e18, 0);

        vm.expectRevert(OutcomeResolver.BandOutOfRange.selector);
        h.resolve(START, 3045e18, -1);
    }

    function test_Resolve_RevertWhen_BandTooLarge() public {
        vm.expectRevert(OutcomeResolver.BandOutOfRange.selector);
        h.resolve(START, 3045e18, 10000); // >= BPS

        vm.expectRevert(OutcomeResolver.BandOutOfRange.selector);
        h.resolve(START, 3045e18, 10001);
    }

    // Map Side to a monotone rank: DOWN < RANGE < UP. NONE is illegal here.
    function _rank(IFeeArena.Side s) internal pure returns (int256) {
        if (s == IFeeArena.Side.DOWN) return -1;
        if (s == IFeeArena.Side.RANGE) return 0;
        if (s == IFeeArena.Side.UP) return 1;
        revert("NONE returned"); // resolve() must never produce NONE
    }

    // (1) exactly one valid Side + (3) single-sourced delta, for any valid input.
    function testFuzz_Resolve_ValidSideAndSingleSourcedDelta(uint256 start, uint256 end, int32 band) public {
        start = bound(start, 1, 1e42);
        end = bound(end, 1, 1e42);
        band = int32(int256(bound(uint256(int256(band)), 1, 9999))); // 0 < band < 10000

        (IFeeArena.Side side, int256 delta) = h.resolve(start, end, band);

        // exactly one of UP/DOWN/RANGE (never NONE)
        assertTrue(
            side == IFeeArena.Side.UP || side == IFeeArena.Side.DOWN || side == IFeeArena.Side.RANGE,
            "side must be UP/DOWN/RANGE"
        );
        assertTrue(side != IFeeArena.Side.NONE, "side must never be NONE");

        // single-sourced delta == independently re-derived decision delta
        int256 expected = (int256(end) - int256(start)) * int256(10000) / int256(start);
        assertEq(delta, expected, "delta must be single-sourced");

        // and the decision is consistent with that delta
        if (delta > int256(band)) {
            assertEq(uint8(side), uint8(IFeeArena.Side.UP), "delta>band -> UP");
        } else if (delta < -int256(band)) {
            assertEq(uint8(side), uint8(IFeeArena.Side.DOWN), "delta<-band -> DOWN");
        } else {
            assertEq(uint8(side), uint8(IFeeArena.Side.RANGE), "interior -> RANGE");
        }
    }

    // (2) monotone in end: higher end never lowers the Side rank (never flips UP->DOWN).
    function testFuzz_Resolve_MonotoneInEnd(uint256 start, uint256 endLow, uint256 endHigh, int32 band) public {
        start = bound(start, 1, 1e42);
        endLow = bound(endLow, 1, 1e42);
        endHigh = bound(endHigh, 1, 1e42);
        band = int32(int256(bound(uint256(int256(band)), 1, 9999)));
        if (endLow > endHigh) (endLow, endHigh) = (endHigh, endLow); // ensure endLow <= endHigh

        (IFeeArena.Side sLow,) = h.resolve(start, endLow, band);
        (IFeeArena.Side sHigh,) = h.resolve(start, endHigh, band);

        assertGe(_rank(sHigh), _rank(sLow), "higher end must not lower the Side rank");
    }
}
