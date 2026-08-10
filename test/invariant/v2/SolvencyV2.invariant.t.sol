// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeArenaV2InvariantBase} from "test/invariant/FeeArenaV2InvariantBase.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {EpochV2, Position} from "src/FeeArenaV2Types.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @notice TOP-PRIORITY (spec §INVARIANTS SOLVENCY): the vault is never insolvent on either leg,
///         accounting conviction + committed subsidy as first-class liabilities.
///           INV-S1: balanceOf(WETH) >= totalOwedWETH + rolloverWETH + ledger(WETH).
///           INV-S2: balanceOf(USDC) >= totalOwedUSDC + rolloverUSDC + totalCommittedSubsidy(live)
///                   + totalCustodiedConviction(live) + ledger(USDC).
///           INV-S3 (consistency): totalOwedUSDC == Σ over open settled epochs of
///                   (potUSDC - claimedUSDC) + (winningConvictionSum - refundedConviction);
///                   totalOwedWETH == Σ (potWETH - claimedWETH). Recomputed externally here.
contract SolvencyV2Invariant is FeeArenaV2InvariantBase {
    /// INV-S1 / INV-S2: vault never insolvent, with conviction + subsidy counted. Recompute the
    /// need from the SUT's O(1) counters and assert the REAL balances cover it.
    function invariant_S1_S2_Solvency() public view {
        uint256 needWETH = arena.totalOwedWETH() + arena.rolloverWETH() + arena.totalLedgerWETH();
        uint256 needUSDC = arena.totalOwedUSDC() + arena.rolloverUSDC() + arena.totalCommittedSubsidy()
            + arena.totalCustodiedConviction() + arena.totalLedgerUSDC();
        assertGe(IERC20(address(weth)).balanceOf(address(arena)), needWETH, "WETH insolvent");
        assertGe(IERC20(address(usdc)).balanceOf(address(arena)), needUSDC, "USDC insolvent");
    }

    /// INV-S3: the O(1) global counters EXACTLY equal the externally-summed per-epoch residuals.
    /// Sum over open SETTLED, non-rolled epochs of (pot - claimed) + (winConvSum - refunded).
    function invariant_S3_OwedCountersConsistent() public view {
        uint256 sumWETH;
        uint256 sumUSDC;
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            EpochV2 memory e = arena.getEpoch(id);
            if (e.phase != IFeeArena.Phase.Settled) continue;
            // A rolled-over epoch moved its whole pot into the rollover globals (not totalOwed),
            // so it contributes ZERO pot residual; its winning conviction is still owed until
            // refunded (rolledOver epochs still permit refundConviction).
            if (!e.rolledOver) {
                sumWETH += e.potWETH - e.claimedWETH;
                sumUSDC += e.potUSDC - e.claimedUSDC;
            }
            sumUSDC += e.winningConvictionSum - e.refundedConviction;
        }
        assertEq(arena.totalOwedWETH(), sumWETH, "totalOwedWETH != sum residual");
        assertEq(arena.totalOwedUSDC(), sumUSDC, "totalOwedUSDC != sum residual + conviction");
    }

    /// CONSERVATION: every USDC/WETH the handler funded in (fees + conviction + subsidy) is either
    /// still HELD by the vault or was paid OUT (claim pot-share + conviction refund + burn). Nothing
    /// minted/leaked/double-paid. (USDC in == fees + conviction + subsidy; WETH in == fees only.)
    function invariant_Conservation() public view {
        uint256 inUSDC = handler.ghost_feesSeededUSDC() + handler.ghost_convFunded() + handler.ghost_subsidyFunded();
        uint256 inWETH = handler.ghost_feesSeededWETH();
        assertEq(
            IERC20(address(usdc)).balanceOf(address(arena)) + handler.ghost_outUSDC(), inUSDC, "USDC not conserved"
        );
        assertEq(
            IERC20(address(weth)).balanceOf(address(arena)) + handler.ghost_outWETH(), inWETH, "WETH not conserved"
        );
    }

    /// Coverage: the run must actually exercise settle (else the asserts above are vacuous).
    /// Checked ONCE at the END of the run (afterInvariant), NOT per-step — a per-step assert would
    /// trivially fail on call #1 before anything has had a chance to settle.
    function afterInvariant() public view {
        assertGe(handler.ghost_epochsSettled(), 1, "no epoch ever settled across the run");
    }
}
