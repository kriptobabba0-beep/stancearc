// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @title EpochViewLib
/// @notice Pure projection helpers that build the UI-facing `EpochView` from the
///         internal `Epoch` row and collapse the authoritative 6-phase `Phase`
///         enum to the external 4-phase `PhaseView` (spec §2.1 / §6.3).
/// @dev    Collapse mapping (the ONLY external phase semantics):
///         None      -> Idle
///         EntryOpen -> EntryOpen
///         Running   -> Running
///         Resolved  -> Running   (sweep in progress; claim/unstake still closed)
///         Swept     -> Running   (denominator not yet frozen)
///         Settled   -> Settled   (claim + unstake OPEN)
library EpochViewLib {
    /// @notice Collapse the internal 6-phase `Phase` to the external `PhaseView`.
    function collapse(IFeeArena.Phase phase) internal pure returns (IFeeArena.PhaseView) {
        if (phase == IFeeArena.Phase.None) {
            return IFeeArena.PhaseView.Idle;
        } else if (phase == IFeeArena.Phase.EntryOpen) {
            return IFeeArena.PhaseView.EntryOpen;
        } else if (phase == IFeeArena.Phase.Settled) {
            return IFeeArena.PhaseView.Settled;
        } else {
            // Running, Resolved, Swept all surface as Running.
            return IFeeArena.PhaseView.Running;
        }
    }

    /// @notice Build the read-optimized `EpochView` for a single epoch row.
    /// @param epochId           the epoch id being viewed.
    /// @param e                 storage pointer to the epoch row.
    /// @param rolloverWETH      current global WETH rollover (surfaced as carry-in if pending).
    /// @param rolloverUSDC      current global USDC rollover (surfaced as carry-in if pending).
    /// @param rolloverPendingIn whether a pending global rollover targets this epoch next.
    function toView(
        uint64 epochId,
        IFeeArena.Epoch storage e,
        uint256 rolloverWETH,
        uint256 rolloverUSDC,
        bool rolloverPendingIn
    ) internal view returns (IFeeArena.EpochView memory v) {
        v.epochId = epochId;
        v.phase = collapse(e.phase);
        v.entryOpenTime = e.entryOpenTime;
        v.entryCloseTime = e.entryCloseTime;
        v.startTime = e.startTime;
        v.endTime = e.endTime;
        v.startTimeActual = e.startTimeActual;
        v.settleTimeActual = e.settleTimeActual;
        v.bandBps = e.bandBps;
        v.startPrice18 = e.startPrice18;
        v.settlePrice18 = e.settlePrice18;
        v.deltaBps = e.deltaBps;
        v.winningSide = e.winningSide;
        v.rolledOver = e.rolledOver;
        v.stakedCount = e.stakedCount;
        v.sweepCursor = e.sweepCursor;
        v.potWETH = e.potWETH;
        v.potUSDC = e.potUSDC;
        v.sideContribution6 = e.sideContribution6;
        v.winnerDenominator = e.winnerDenominator;
        v.rolloverPendingIn = rolloverPendingIn;
        v.rolloverInWETH = rolloverPendingIn ? rolloverWETH : 0;
        v.rolloverInUSDC = rolloverPendingIn ? rolloverUSDC : 0;
    }
}
