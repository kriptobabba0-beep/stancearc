// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";

/// @notice Task M6 — empty-winner rollover branch, compounding chain across epochs,
///         and counter-based foldDust.
contract EmptyWinnerRolloverTest is FeeArenaTestBase {
    address lpDown = makeAddr("down");
    address lpRange = makeAddr("range");
    address lpUp = makeAddr("up");

    function test_EmptyWinner_RollsWholePot_NoDivision() public {
        // everyone DOWN/RANGE; force UP win -> UP side S==0 -> rollover
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lpDown, IFeeArena.Side.DOWN, 2e18, 1000e6);
        _stakeOwed(lpRange, IFeeArena.Side.RANGE, 0, 500e6);
        _startCurrentAt(3000e18);
        _endEpochAtPrice(3300e18); // +10% -> UP wins, but no UP stakers
        arena.sweep(10);

        IFeeArena.EpochView memory pre = arena.getEpoch(id);
        vm.expectEmit(true, false, false, true);
        emit IFeeArena.EmptyWinnerRollover(id, IFeeArena.Side.UP, pre.potWETH, pre.potUSDC);
        arena.finalizeSettle();

        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertTrue(e.rolledOver);
        assertEq(e.winnerDenominator, 0, "no denominator on empty winner");
        assertEq(arena.rolloverWETH(), 2e18, "whole WETH pot rolled");
        assertEq(arena.rolloverUSDC(), 1500e6, "whole USDC pot rolled");
    }

    function test_EmptyWinner_ClaimReverts_AlreadyRolledOver() public {
        test_EmptyWinner_RollsWholePot_NoDivision();
        uint64 id = arena.lastSettledEpochId();
        vm.expectRevert(IFeeArena.AlreadyRolledOver.selector);
        arena.claim(id, _tokenIdOf(lpDown));
    }

    /// @dev Audit test-coverage-2: the winning side is STAKED but every winning position
    ///      realized ZERO fees (out-of-range proxy) so its contribution6 == 0 => the winning
    ///      side's sideContribution6 is 0 => the EMPTY-WINNER branch fires even though the
    ///      side is non-empty. A fee-realizing LOSING side funds the pot. Assert the whole
    ///      (post-inject) pot rolls forward (winnerDenominator == 0, EmptyWinnerRollover
    ///      emitted for the WINNING side), and a winning position's claim reverts
    ///      AlreadyRolledOver.
    function test_EmptyWinner_StakedButZeroContribution_RollsWholePot() public {
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();

        // Winning side (UP) is staked but its position realizes ZERO fees -> contribution 0.
        address upZero = makeAddr("upZero");
        _stakeOwed(upZero, IFeeArena.Side.UP, 0, 0); // in-range proxy false -> contribution6 == 0
        // Losing side (DOWN) realizes fees -> funds the pot.
        _stakeOwed(lpDown, IFeeArena.Side.DOWN, 2e18, 1000e6);

        _startCurrentAt(3000e18);
        _endEpochAtPrice(3300e18); // +10% -> UP wins; the only UP staker has zero contribution
        arena.sweep(10);

        IFeeArena.EpochView memory pre = arena.getEpoch(id);
        // sanity: UP side has zero contribution despite being staked
        assertEq(pre.sideContribution6[uint8(IFeeArena.Side.UP)], 0, "winning side contribution is zero");
        IFeeArena.StakeView memory uz = arena.getStake(_tokenIdOf(upZero));
        assertEq(uz.contribution6, 0, "zero-fee winning position has zero contribution");

        // EmptyWinnerRollover MUST be emitted for the WINNING side (UP), whole pot.
        vm.expectEmit(true, false, false, true);
        emit IFeeArena.EmptyWinnerRollover(id, IFeeArena.Side.UP, pre.potWETH, pre.potUSDC);
        arena.finalizeSettle();

        IFeeArena.EpochView memory e = arena.getEpoch(id);
        assertTrue(e.rolledOver, "epoch rolled over");
        assertEq(e.winnerDenominator, 0, "no denominator on empty winner");
        assertEq(arena.winnerCount(id), 0, "no winners with positive contribution");
        // whole pot moved to the global rollover (DOWN realized 2 WETH + 1000 USDC).
        assertEq(arena.rolloverWETH(), pre.potWETH, "whole WETH pot rolled to rollover");
        assertEq(arena.rolloverUSDC(), pre.potUSDC, "whole USDC pot rolled to rollover");
        assertEq(arena.rolloverWETH(), 2e18, "whole WETH pot");
        assertEq(arena.rolloverUSDC(), 1000e6, "whole USDC pot");

        // the winning-side position cannot claim: epoch is rolled over.
        vm.expectRevert(IFeeArena.AlreadyRolledOver.selector);
        arena.claim(id, _tokenIdOf(upZero));
    }

    function test_EmptyWinner_To_Normal_InjectsCompounded() public {
        test_EmptyWinner_RollsWholePot_NoDivision(); // rollover = 2 WETH + 1500 USDC
        // next epoch normal UP winner
        vm.prank(owner);
        uint64 id2 = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lpUp, IFeeArena.Side.UP, 1e18, 1000e6);
        _startCurrentAt(3000e18);
        _endEpochAtPrice(3300e18); // UP wins
        arena.sweep(10);

        vm.expectEmit(true, false, false, true);
        emit IFeeArena.RolloverInjected(id2, 2e18, 1500e6);
        arena.finalizeSettle();

        IFeeArena.EpochView memory e = arena.getEpoch(id2);
        assertEq(e.potWETH, 1e18 + 2e18);
        assertEq(e.potUSDC, 1000e6 + 1500e6);
        assertEq(arena.rolloverWETH(), 0);
        assertEq(arena.rolloverUSDC(), 0);
    }

    /// @dev Three equal-LIQUIDITY UP winners share a 1 WETH pot 3 ways; the floor loses
    ///      1 wei -> WETH dust 1 (USDC pot 6000e6 divides evenly -> USDC dust 0). Each is
    ///      minted with MIN_LIQUIDITY and realizes a fee (in-range), so each contributes
    ///      MIN_LIQUIDITY; denom = 3 * MIN_LIQUIDITY. The fee mix per winner no longer
    ///      affects the split (anti-wash) — only that each realized >0.
    function test_FoldDust_RollsRemainderForward() public {
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        address w1 = makeAddr("w1");
        address w2 = makeAddr("w2");
        address w3 = makeAddr("w3");
        _stakeOwed(w1, IFeeArena.Side.UP, 1e18, 0); // in-range -> contrib MIN_LIQUIDITY
        _stakeOwed(w2, IFeeArena.Side.UP, 0, 3000e6); // in-range -> contrib MIN_LIQUIDITY
        _stakeOwed(w3, IFeeArena.Side.UP, 0, 3000e6); // in-range -> contrib MIN_LIQUIDITY
        _startCurrentAt(2000e18); // low start so 3000 settle is a clean UP win
        _endEpochAtPrice(3000e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();

        // pot: 1 WETH + 6000 USDC; denom = 3 * MIN_LIQUIDITY * DEFAULT_TICK_SPAN
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        assertEq(e0.potWETH, 1e18);
        assertEq(e0.potUSDC, 6000e6);
        assertEq(e0.winnerDenominator, 3 * uint256(MIN_LIQUIDITY) * uint256(DEFAULT_TICK_SPAN));

        arena.claim(id, _tokenIdOf(w1));
        arena.claim(id, _tokenIdOf(w2));
        arena.claim(id, _tokenIdOf(w3));

        // each WETH payout = floor(1e18 * MIN_LIQ / (3*MIN_LIQ)) = 333333333333333333; sum lacks 1 wei
        vm.expectEmit(true, false, false, true);
        emit IFeeArena.DustFolded(id, 1, 0);
        arena.foldDust(id);
        assertEq(arena.rolloverWETH(), 1, "1 wei WETH dust rolled forward");
        assertEq(arena.rolloverUSDC(), 0, "USDC pot divides evenly -> no USDC dust");
    }

    function test_FoldDust_RevertsBeforeAllClaimed() public {
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        address w1 = makeAddr("g1");
        address w2 = makeAddr("g2");
        _stakeOwed(w1, IFeeArena.Side.UP, 1e18, 0);
        _stakeOwed(w2, IFeeArena.Side.UP, 1e18, 0);
        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18);
        arena.sweep(10);
        arena.finalizeSettle();
        arena.claim(id, _tokenIdOf(w1));
        vm.expectRevert(IFeeArena.NotAllClaimed.selector);
        arena.foldDust(id);
    }

    /// @dev Regression: a WINNING-side position whose `collect` reverts during sweep ends
    ///      up swept with `contribution6 == 0` and is excluded from `winnerCount`. Its
    ///      `claim` must revert `NothingToClaim` (NOT bump `claimedCount`), so once the real
    ///      winners claim, `foldDust` succeeds — previously the zero-contribution claim
    ///      pushed `claimedCount > winnerCount` and bricked `foldDust` with `NotAllClaimed`.
    function test_ZeroContributionWinner_ClaimReverts_FoldDustSucceeds() public {
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        address w1 = makeAddr("zc1");
        address w2 = makeAddr("zc2");
        address wBad = makeAddr("zcBad");
        // Three UP winners; wBad's collect will revert -> contribution6 == 0.
        _stakeOwed(w1, IFeeArena.Side.UP, 1e18, 0); // in-range -> contrib MIN_LIQUIDITY
        _stakeOwed(w2, IFeeArena.Side.UP, 0, 3000e6); // in-range -> contrib MIN_LIQUIDITY
        _stakeOwed(wBad, IFeeArena.Side.UP, 1e18, 0); // collect reverts -> contrib 0
        _makeCollectRevertFor(wBad);
        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18); // UP wins

        vm.expectEmit(true, true, false, false);
        emit IFeeArena.SweepFailed(id, _tokenIdOf(wBad));
        arena.sweep(10);
        arena.finalizeSettle();

        // wBad swept with zero contribution; denominator excludes it.
        IFeeArena.StakeView memory bad = arena.getStake(_tokenIdOf(wBad));
        assertTrue(bad.swept, "bad position is swept");
        assertEq(bad.contribution6, 0, "reverted collect -> zero contribution");
        IFeeArena.EpochView memory e0 = arena.getEpoch(id);
        // denominator = the two real in-range winners' liquidity*span (2 * MIN_LIQUIDITY * span)
        assertEq(
            e0.winnerDenominator,
            2 * uint256(MIN_LIQUIDITY) * uint256(DEFAULT_TICK_SPAN),
            "denominator only counts the two real winners"
        );
        assertEq(arena.winnerCount(id), 2, "winnerCount excludes zero-contribution winner");

        // Real winners claim; pot (1 WETH + 3000 USDC) splits evenly -> no dust.
        arena.claim(id, _tokenIdOf(w1));
        arena.claim(id, _tokenIdOf(w2));

        // The zero-contribution winner's claim reverts and does NOT bump claimedCount.
        vm.expectRevert(IFeeArena.NothingToClaim.selector);
        arena.claim(id, _tokenIdOf(wBad));

        // foldDust now succeeds (claimedCount == winnerCount). Pre-fix this reverted
        // NotAllClaimed forever. Here pot splits evenly so it folds zero residual.
        vm.expectRevert(IFeeArena.NothingToFold.selector);
        arena.foldDust(id);
    }

    /// @dev As above but with a floor residual so `foldDust` actually rolls dust forward,
    ///      proving the gate clears (not just that nothing was owed). Three real UP winners
    ///      of equal contribution split a 1-wei-indivisible WETH pot; a fourth winner's
    ///      collect reverts (zero contribution).
    function test_ZeroContributionWinner_FoldDustRollsRemainder() public {
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        address w1 = makeAddr("zd1");
        address w2 = makeAddr("zd2");
        address w3 = makeAddr("zd3");
        address wBad = makeAddr("zdBad");
        _stakeOwed(w1, IFeeArena.Side.UP, 1e18, 0); // in-range -> contrib MIN_LIQUIDITY
        _stakeOwed(w2, IFeeArena.Side.UP, 0, 3000e6); // in-range -> contrib MIN_LIQUIDITY
        _stakeOwed(w3, IFeeArena.Side.UP, 0, 3000e6); // in-range -> contrib MIN_LIQUIDITY
        _stakeOwed(wBad, IFeeArena.Side.UP, 1e18, 0); // collect reverts -> contrib 0
        _makeCollectRevertFor(wBad);
        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18); // UP wins
        arena.sweep(10);
        arena.finalizeSettle();

        assertEq(arena.winnerCount(id), 3, "winnerCount excludes the reverted-collect winner");

        arena.claim(id, _tokenIdOf(w1));
        arena.claim(id, _tokenIdOf(w2));
        arena.claim(id, _tokenIdOf(w3));

        vm.expectRevert(IFeeArena.NothingToClaim.selector);
        arena.claim(id, _tokenIdOf(wBad));

        // pot 1 WETH / denom 3*MIN_LIQ: each WETH payout floors, sum lacks 1 wei -> dust 1.
        vm.expectEmit(true, false, false, true);
        emit IFeeArena.DustFolded(id, 1, 0);
        arena.foldDust(id);
        assertEq(arena.rolloverWETH(), 1, "1 wei WETH dust rolled forward");
        assertEq(arena.rolloverUSDC(), 0, "USDC pot divides evenly -> no USDC dust");
    }

    function test_FoldDust_NothingToFold_Reverts() public {
        // single winner takes the whole pot exactly -> dust 0
        vm.prank(owner);
        uint64 id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        address w1 = makeAddr("solo");
        _stakeOwed(w1, IFeeArena.Side.UP, 1e18, 0);
        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18);
        arena.sweep(10);
        arena.finalizeSettle();
        arena.claim(id, _tokenIdOf(w1));
        vm.expectRevert(IFeeArena.NothingToFold.selector);
        arena.foldDust(id);
    }
}
