// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Anti-manipulation: the winner pot is split by RANGE-NORMALIZED STAKED IN-RANGE
///         LIQUIDITY (`contribution6 = (realizedAnyFee) ? liquidity * tickSpan : 0`), NOT by
///         the realized fee USDC-notional (wash-trade-gameable) and NOT by raw liquidity
///         (tick-range-concentration-gameable: in V3 L ~ capital/tickSpan, so a razor-thin
///         range yields huge L per dollar). Multiplying by tickSpan makes share track
///         deposited CAPITAL, not range tightness or fee-luck. Pot funding (the realized
///         fees of all sides) is unchanged; only the per-position split metric changes.
contract AntiManipulationTest is FeeArenaTestBase {
    /// @dev Mint with explicit liquidity, stake on `side`, program the fees collect() yields.
    ///      Mirrors the base `_stakeOwed` but lets a test pick the staked liquidity, which is
    ///      the new contribution metric.
    function _stakeLiqOwed(address lp, IFeeArena.Side side, uint128 liquidity, uint256 owedWeth, uint256 owedUsdc)
        internal
        returns (uint256 tokenId)
    {
        tokenId = _mintPosition(lp, liquidity);
        vm.roll(block.number + 1); // one-action-per-block guard across multiple stakers
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(side));
        tokenIdByOwner[lp] = tokenId;
        _programOwed(tokenId, owedWeth, owedUsdc);
    }

    /// @dev Like `_stakeLiqOwed` but with an EXPLICIT tick range so the test can pin the
    ///      tickSpan (= tickUpper - tickLower), exercising the range-normalization metric.
    function _stakeRangeLiqOwed(
        address lp,
        IFeeArena.Side side,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper,
        uint256 owedWeth,
        uint256 owedUsdc
    ) internal returns (uint256 tokenId) {
        tokenId = _mintPositionWithRange(lp, liquidity, tickLower, tickUpper);
        vm.roll(block.number + 1); // one-action-per-block guard across multiple stakers
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(side));
        tokenIdByOwner[lp] = tokenId;
        _programOwed(tokenId, owedWeth, owedUsdc);
    }

    /// @dev Wash-resistance: two winning-side positions with EQUAL staked liquidity AND
    ///      EQUAL span (both default-minted) but WILDLY UNEQUAL realized fees (one wash-traded
    ///      to 1000 USDC, the other only 10) end up with EQUAL contribution6
    ///      (== liquidity * tickSpan) and EQUAL pot shares. Under the OLD fee-notional metric
    ///      the heavy-fee position would have captured the pot.
    function test_WashResistance_EqualLiquidity_EqualShare_RegardlessOfFees() public {
        address heavyFee = makeAddr("heavyFee"); // attacker who wash-traded a big fee
        address lightFee = makeAddr("lightFee"); // honest LP with a tiny realized fee

        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();

        // Both UP (winning side), SAME liquidity, very different realized fees.
        uint128 liq = 50_000;
        _stakeLiqOwed(heavyFee, IFeeArena.Side.UP, liq, 0, 1000e6); // washed-in big fee
        _stakeLiqOwed(lightFee, IFeeArena.Side.UP, liq, 0, 10e6); // tiny honest fee

        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();

        // Equal contribution despite a 100x fee gap. contribution6 == liquidity * tickSpan.
        uint256 expectC6 = uint256(liq) * uint256(DEFAULT_TICK_SPAN);
        IFeeArena.StakeView memory h = arena.getStake(_tokenIdOf(heavyFee));
        IFeeArena.StakeView memory l = arena.getStake(_tokenIdOf(lightFee));
        assertEq(h.contribution6, expectC6, "heavy-fee contribution == liquidity * tickSpan");
        assertEq(l.contribution6, expectC6, "light-fee contribution == liquidity * tickSpan");
        assertEq(h.contribution6, l.contribution6, "equal liquidity+span -> equal contribution");

        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertEq(e.winnerDenominator, 2 * expectC6, "denominator = sum of the two equal contributions");

        // Pot = total realized fees of all sides = 1000e6 + 10e6 USDC (both UP here). Each
        // winner takes exactly half regardless of which realized more fees.
        IFeeArena.ClaimPreview memory pvH = arena.previewClaim(id, _tokenIdOf(heavyFee));
        IFeeArena.ClaimPreview memory pvL = arena.previewClaim(id, _tokenIdOf(lightFee));
        assertEq(pvH.payUSDC, pvL.payUSDC, "equal liquidity -> equal USDC payout");
        assertEq(pvH.payWETH, pvL.payWETH, "equal liquidity -> equal WETH payout");
        assertEq(pvH.payUSDC, e.potUSDC / 2, "each winner takes half the USDC pot");

        // Realized claims confirm the preview.
        arena.claim(id, _tokenIdOf(heavyFee));
        arena.claim(id, _tokenIdOf(lightFee));
        assertEq(
            IERC20(address(usdc)).balanceOf(heavyFee),
            IERC20(address(usdc)).balanceOf(lightFee),
            "equal liquidity -> equal realized USDC"
        );
    }

    /// @dev In-range gate: a winning-side position that realizes ZERO fees (out-of-range /
    ///      inactive proxy) gets contribution6 == 0 and is not claimable (zero payout), while
    ///      an in-range sibling on the same side captures the whole winner pot.
    function test_OutOfRange_NoFee_ZeroContribution_NoPayout() public {
        address inRange = makeAddr("inRange");
        address outRange = makeAddr("outRange");

        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();

        // Both UP; outRange realizes NO fee (collect yields 0/0) -> out-of-range proxy.
        _stakeLiqOwed(inRange, IFeeArena.Side.UP, 20_000, 1e18, 2000e6);
        _stakeLiqOwed(outRange, IFeeArena.Side.UP, 1_000_000, 0, 0); // huge liquidity, but 0 fees

        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();

        // Out-of-range winner: zero contribution, cannot free-ride the pot with cheap liquidity.
        IFeeArena.StakeView memory o = arena.getStake(_tokenIdOf(outRange));
        assertEq(o.contribution6, 0, "no realized fee -> zero contribution");

        // Zero-contribution winner: previewClaim reports a ZERO payout AND claimable==false
        // (now gated on contribution6 > 0), and the actual claim reverts NothingToClaim below.
        IFeeArena.ClaimPreview memory pvOut = arena.previewClaim(id, _tokenIdOf(outRange));
        assertEq(pvOut.contribution6, 0, "zero-contribution surfaced in preview");
        assertEq(pvOut.claimable, false, "zero-contribution winner not claimable (gated on contribution>0)");
        assertEq(pvOut.payWETH, 0, "zero-contribution winner zero WETH payout");
        assertEq(pvOut.payUSDC, 0, "zero-contribution winner zero USDC payout");

        // Its claim reverts (NothingToClaim), so it never bumps claimedCount.
        vm.expectRevert(IFeeArena.NothingToClaim.selector);
        arena.claim(id, _tokenIdOf(outRange));

        // The in-range sibling is the only contributor -> takes the WHOLE winner pot.
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertEq(
            e.winnerDenominator,
            uint256(20_000) * uint256(DEFAULT_TICK_SPAN),
            "denominator = only the in-range winner's liquidity * span"
        );
        arena.claim(id, _tokenIdOf(inRange));
        assertEq(IERC20(address(weth)).balanceOf(inRange), e.potWETH, "in-range winner takes whole WETH pot");
        assertEq(IERC20(address(usdc)).balanceOf(inRange), e.potUSDC, "in-range winner takes whole USDC pot");
    }

    /// @dev Contribution equals liquidity * tickSpan: an in-range winner's contribution6 is
    ///      exactly the staked liquidity range-normalized by its tick span (not a fee-derived
    ///      USDC notional, and not raw liquidity).
    function test_Contribution_EqualsLiquidityTimesTickSpan() public {
        address lp = makeAddr("depthLP");
        uint128 stakedLiquidity = 1_234_567;

        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();

        _stakeLiqOwed(lp, IFeeArena.Side.UP, stakedLiquidity, 3e18, 5000e6);
        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18); // UP wins; position realized fees -> in-range
        arena.sweep(10);

        // read the REAL ticks the position carries and compute the expected span
        (,,,,, int24 tl, int24 tu, uint128 liq,,,,) = npm.positions(_tokenIdOf(lp));
        uint256 span = uint256(uint24(tu - tl));
        IFeeArena.StakeView memory s = arena.getStake(_tokenIdOf(lp));
        assertEq(s.contribution6, uint256(stakedLiquidity) * span, "contribution == liquidity * tickSpan");
        // sanity: the liquidity reported by the NPM mock matches what we minted/staked.
        assertEq(uint256(liq), uint256(stakedLiquidity), "minted liquidity matches");
        assertEq(span, uint256(DEFAULT_TICK_SPAN), "default-minted span");
    }

    /// @dev Range-normalization (the audit econ-1 fix). A concentrated tiny-span position
    ///      must NOT dominate an equal-CAPITAL wide position:
    ///       - Winner A: HIGH liquidity, NARROW span. Winner B: LOW liquidity, WIDE span,
    ///         chosen so L_A * span_A == L_B * span_B. Their contribution6 (and pot shares)
    ///         must be EQUAL — razor-thin concentration buys NO extra share for equal capital.
    ///       - Two SAME-liquidity positions: the one with the LARGER span gets the LARGER
    ///         contribution (span matters; raw liquidity alone would tie them).
    function test_RangeNormalization_ConcentratedDoesNotDominate() public {
        address aNarrow = makeAddr("aNarrow"); // high L, narrow span
        address bWide = makeAddr("bWide"); // low L, wide span

        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();

        // L_A * span_A == L_B * span_B == 4_000_000 (equal capital proxy).
        // A: L=4000, span=1000 (ticks [-500,500]).  B: L=1000, span=4000 (ticks [-2000,2000]).
        _stakeRangeLiqOwed(aNarrow, IFeeArena.Side.UP, 4000, -500, 500, 1e18, 0);
        _stakeRangeLiqOwed(bWide, IFeeArena.Side.UP, 1000, -2000, 2000, 0, 1000e6);

        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();

        IFeeArena.StakeView memory a = arena.getStake(_tokenIdOf(aNarrow));
        IFeeArena.StakeView memory b = arena.getStake(_tokenIdOf(bWide));
        assertEq(a.contribution6, uint256(4000) * 1000, "A contribution = L*span");
        assertEq(b.contribution6, uint256(1000) * 4000, "B contribution = L*span");
        assertEq(a.contribution6, b.contribution6, "equal L*span -> equal contribution (no concentration edge)");

        // Equal contribution -> equal pot shares despite A having 4x the raw liquidity.
        IFeeArena.ClaimPreview memory pvA = arena.previewClaim(id, _tokenIdOf(aNarrow));
        IFeeArena.ClaimPreview memory pvB = arena.previewClaim(id, _tokenIdOf(bWide));
        assertEq(pvA.payUSDC, pvB.payUSDC, "equal capital -> equal USDC share");
        assertEq(pvA.payWETH, pvB.payWETH, "equal capital -> equal WETH share");

        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertEq(e.winnerDenominator, a.contribution6 + b.contribution6, "denominator = sum of contributions");
    }

    /// @dev Span matters: two SAME-liquidity in-range winners, one with a LARGER span, get
    ///      a LARGER contribution (under raw-liquidity they would have tied).
    function test_RangeNormalization_LargerSpanLargerContribution_SameLiquidity() public {
        address wide = makeAddr("wideSpan");
        address narrow = makeAddr("narrowSpan");

        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();

        uint128 liq = 50_000; // SAME liquidity for both
        _stakeRangeLiqOwed(wide, IFeeArena.Side.UP, liq, -3000, 3000, 1e18, 0); // span 6000
        _stakeRangeLiqOwed(narrow, IFeeArena.Side.UP, liq, -1000, 1000, 1e18, 0); // span 2000

        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18); // UP wins
        arena.sweep(10);

        IFeeArena.StakeView memory w = arena.getStake(_tokenIdOf(wide));
        IFeeArena.StakeView memory n = arena.getStake(_tokenIdOf(narrow));
        assertEq(w.contribution6, uint256(liq) * 6000, "wide = L * 6000");
        assertEq(n.contribution6, uint256(liq) * 2000, "narrow = L * 2000");
        assertGt(w.contribution6, n.contribution6, "larger span -> larger contribution for equal liquidity");
    }
}
