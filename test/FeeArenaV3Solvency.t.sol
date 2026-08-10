// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaV3TestBase} from "test/utils/FeeArenaV3TestBase.sol";
import {IFeeArenaV3} from "src/interfaces/IFeeArenaV3.sol";

/// @notice Proves the O(1) solvency refactor: finalize gas is FLAT no matter how many epochs the
///         arena has settled (the fix for the unbounded `_assertSolvent` loop that would have
///         pushed finalize past the 16,777,216 RPC gas cap and permanently wedged the market), and
///         the running `obligationBase/USDC` aggregate stays exactly equal to the real
///         settled-but-unclaimed obligation across finalize / claim / empty-winner / emergency.
contract FeeArenaV3SolvencyTest is FeeArenaV3TestBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    /// @dev Drive one full RANGE-winner round (entry == final so RANGE wins) with fees, returning
    ///      the gas finalizeEpoch consumed. Each round leaves an unclaimed winner, so obligation
    ///      GROWS every round — the perfect stress for "does finalize loop over history?".
    function _roundWithFeesMeasuringFinalize(address lp) internal returns (uint256 finalizeGas) {
        _openEpoch();
        uint256 tokenId = _stakeAt(lp, IFeeArenaV3.Side.RANGE, P100K);
        _programOwed(tokenId, 5_000, 2_000_000); // small base + usdc fees -> non-zero contribution
        _settleAt(P100K); // changeBps 0 -> strictly inside band -> RANGE wins
        _processAll();
        uint64 id = arena.currentEpochId();
        uint256 g0 = gasleft();
        arena.finalizeEpoch(id);
        finalizeGas = g0 - gasleft();
    }

    function test_FinalizeGas_IsFlat_AcrossManyEpochs() public {
        uint256 gasEarly;
        uint256 gasLate;
        uint256 obligationEarly;
        uint256 obligationLate;

        // 60 rounds, each leaving an unclaimed settled winner. With the old O(n) loop, finalize at
        // round 55 would cost ~50 * ~10k = ~500k gas MORE than round 5. With O(1) it's flat.
        for (uint256 i = 1; i <= 60; ++i) {
            uint256 g = _roundWithFeesMeasuringFinalize(i % 2 == 0 ? alice : bob);
            if (i == 5) {
                gasEarly = g;
                obligationEarly = arena.obligationUSDC();
            }
            if (i == 55) {
                gasLate = g;
                obligationLate = arena.obligationUSDC();
            }
        }

        // The DATA grew (obligation accumulates every unclaimed winner) ...
        assertGt(obligationLate, obligationEarly, "obligation must accumulate across rounds");
        // ... but the finalize GAS did not. Allow a tiny slop for value-dependent opcodes; the old
        // loop would blow a ~500k hole here, so a <10k bound unambiguously proves O(1).
        uint256 delta = gasLate > gasEarly ? gasLate - gasEarly : gasEarly - gasLate;
        assertLt(delta, 10_000, "finalize gas must be flat (O(1)) across epoch history");
    }

    function test_Obligation_TracksSettledUnclaimed_AndClaimRetiresIt() public {
        _openEpoch();
        _setPrice(P100K);
        uint256 aliceTok = _stakeExpecting(alice, IFeeArenaV3.Side.UP, P100K, 50);
        uint256 bobTok = _stakeExpecting(bob, IFeeArenaV3.Side.DOWN, P100K, 50);

        // Alice's winning position produced fees; Bob's losing position produced fees that become
        // the forfeited pot Alice (the only winner) sweeps.
        _programOwed(aliceTok, 3_000, 1_000_000);
        _programOwed(bobTok, 7_000, 4_000_000);

        _settleAt(102_000e18); // +2% -> UP wins, DOWN loses
        _processAll();
        _finalize();

        // Before any claim, the whole epoch's collected fees are an outstanding obligation.
        uint256 expectBase = 3_000 + 7_000;
        uint256 expectUsdc = 1_000_000 + 4_000_000;
        assertEq(arena.obligationBase(), expectBase, "obligation base == all escrowed fees pre-claim");
        assertEq(arena.obligationUSDC(), expectUsdc, "obligation usdc == all escrowed fees pre-claim");

        // Alice (sole winner) claims own fees + the entire loser pot -> obligation fully retired.
        uint256 aliceBaseBefore = base.balanceOf(alice);
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);
        arena.claim(aliceTok);

        assertEq(base.balanceOf(alice) - aliceBaseBefore, expectBase, "alice receives all base");
        assertEq(usdc.balanceOf(alice) - aliceUsdcBefore, expectUsdc, "alice receives all usdc");
        assertEq(arena.obligationBase(), 0, "claim retires the base obligation exactly");
        assertEq(arena.obligationUSDC(), 0, "claim retires the usdc obligation exactly");
    }

    function test_EmptyWinner_ObligationStaysZero_FundsTrackedAsRollover() public {
        _openEpoch();
        _setPrice(P100K);
        // Single DOWN position; price goes UP -> the only position LOSES -> no winners.
        uint256 tok = _stakeExpecting(bob, IFeeArenaV3.Side.DOWN, P100K, 50);
        _programOwed(tok, 9_000, 6_000_000);

        _settleAt(102_000e18); // +2% -> DOWN loses, no winner
        _processAll();
        _finalize();

        // No claimable winner -> the pot rolls forward; it is tracked under rollover, NOT obligation.
        assertEq(arena.obligationBase(), 0, "empty-winner epoch adds zero obligation");
        assertEq(arena.obligationUSDC(), 0, "empty-winner epoch adds zero obligation");
        assertEq(arena.rolloverBase(), 9_000, "forfeited base rolls forward");
        assertEq(arena.rolloverUSDC(), 6_000_000, "forfeited usdc rolls forward");
    }

    function test_EmergencySettle_DrainsToRollover_ObligationZero() public {
        _openEpoch();
        _setPrice(P100K);
        uint256 tok = _stakeExpecting(alice, IFeeArenaV3.Side.UP, P100K, 50);
        _programOwed(tok, 0, 0); // no fees collected before the oracle died

        uint64 id = arena.currentEpochId();
        IFeeArenaV3.EpochView memory e = arena.getEpoch(id);
        vm.warp(uint256(e.settlementTime) + 601); // past settlementTime + GRACE(600)
        vm.prank(owner); // applies to the very next external call only
        arena.emergencySettle(id);

        // Emergency settle drains everything to rollover and opens unstake; zero obligation, solvent.
        assertEq(arena.obligationBase(), 0, "emergency settle leaves zero base obligation");
        assertEq(arena.obligationUSDC(), 0, "emergency settle leaves zero usdc obligation");

        // The NFT is now recoverable (epoch is Settled).
        vm.prank(alice);
        arena.unstake(tok);
        assertEq(npm.ownerOf(tok), alice, "owner recovers NFT after emergency settle");
    }
}
