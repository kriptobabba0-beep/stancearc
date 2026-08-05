// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {EpochV2, Position, Globals} from "src/FeeArenaV2Types.sol";

/// @dev Minimal view of the arena's self-only ERC-20 transfer wrappers, so the (delegatecall-linked)
///      payout helpers below can isolate a reverting/blocklisted transfer via try/catch. Under
///      delegatecall `address(this)` is the arena, so `externalTransfer*`'s `msg.sender==address(this)`
///      guard is satisfied by the arena calling itself.
interface IArenaTransfer {
    function externalTransferUSDC(address to, uint256 amount) external;
    function externalTransferWETH(address to, uint256 amount) external;
}

/// @title FeeArenaV2Settlement - external settlement math for {FeeArenaV2} (EIP-170 extraction).
/// @notice The heavy settle/finalize/sweep/claim/refund/foldDust computation lives here as PUBLIC
///         library functions so its bytecode is deployed SEPARATELY (and DELEGATECALL-linked by
///         forge) - it leaves the main contract's runtime, getting it under the 24,576-byte limit.
///
///         Storage discipline: the canonical {EpochV2} / {Position} rows are declared HERE so the
///         arena's `epochs`/`positions` mappings (typed `FeeArenaV2Settlement.EpochV2`/`.Position`)
///         can be passed as `storage` references into these functions - Solidity shares the arena's
///         storage layout with the library across delegatecall, so the writes land in the arena's
///         slots EXACTLY as the in-contract code did. The library NEVER touches the arena's scalar
///         global counters or emits events: each function RETURNS a {Deltas} record, and the arena's
///         thin (nonReentrant / whenNotPaused / CEI-ordered) wrapper applies the global counter
///         updates, emits the events, and performs the (blocklist-resilient) token payouts. This
///         keeps the economic behavior BYTE-IDENTICAL to the pre-extraction contract while moving
///         the bulk of the code out.
library FeeArenaV2Settlement {
    using SafeCast for uint256;

    uint256 internal constant BPS = 10_000;
    uint64 internal constant GRACE = 600; // mirrors FeeArenaV2.GRACE (emergencySettle grace window).

    // The library updates the arena's {Globals} counters DIRECTLY (via a `Globals storage g` ref
    // shared across delegatecall) and emits the v2 events / does the blocklist-resilient payouts
    // ITSELF (same event topics + same `address(this)`==arena under delegatecall). The arena's thin
    // wrapper keeps the external modifiers (nonReentrant / whenNotPaused / onlyOwner), sets
    // lastSettledEpochId, and calls _assertSolvent after - CEI + guards intact.

    // =====================================================================
    // SWEEP - fold one position into the pot + the sqrt-conviction tally.
    // =====================================================================

    /// @dev Sweep ONE position (the body of FeeArenaV2._sweepOne): reclassify winning-side
    ///      conviction (whether or not the collect succeeds), record the collected fees + the
    ///      contribution6, and fold the sqrt-weighted winner tally for real in-range winners.
    ///      The collect itself is performed by the arena (it owns the NPM + the try/catch isolation
    ///      + the externalCollect self-call); the arena passes the (success, feeWeth, feeUsdc)
    ///      outcome in. Returns whether this position incremented the winner count.
    function sweepOne(EpochV2 storage e, Position storage p, bool collectOk, uint256 feeWeth, uint256 feeUsdc)
        public
        returns (bool winnerCounted)
    {
        if (p.swept) return false; // defensive; cursor normally guarantees not-yet-swept

        bool winning = p.side == e.winningSide;
        if (winning) e.winningConvictionSum += p.conviction;

        if (collectOk) {
            uint128 fw = SafeCast.toUint128(feeWeth);
            uint128 fu = SafeCast.toUint128(feeUsdc);
            uint256 c6 = (fw > 0 || fu > 0) ? uint256(p.liquidity) * uint256(p.tickSpan) : 0;
            p.feeWETH = fw;
            p.feeUSDC = fu;
            p.contribution6 = c6;
            p.swept = true;
            e.potWETH += feeWeth;
            e.potUSDC += feeUsdc;
            e.sideContribution6[uint256(uint8(p.side))] += c6;
            if (winning && c6 > 0) {
                e.winnerSqrtConvSum += Math.sqrt(p.conviction);
                return true;
            }
            return false;
        } else {
            p.swept = true; // mark-and-skip; zero contribution (conviction still refundable)
            return false;
        }
    }

    // =====================================================================
    // FINALIZE - O(1): inject rollover, R-cap, BURN losers, freeze sqrt denom.
    // =====================================================================

    /// @dev The full body of FeeArenaV2.finalizeSettle's EFFECTS (steps 1-5), writing the arena's
    ///      {Globals} counters DIRECTLY + emitting the v2 events + doing the (blocklist-resilient)
    ///      BURN payout to `treasury`. The arena wrapper sets lastSettledEpochId + calls
    ///      _assertSolvent after. CEI: every state effect precedes the single BURN interaction.
    function finalizeSettle(
        EpochV2 storage e,
        Globals storage g,
        mapping(address => uint256) storage owedUSDC,
        uint64 id,
        address treasury
    ) public {
        // ---- step 1: inject pending rollover exactly once. ----
        e.rolloverConsumed = true;
        uint256 rw = g.rolloverWETH;
        uint256 ru = g.rolloverUSDC;
        if (rw != 0 || ru != 0) {
            e.potWETH += rw;
            e.potUSDC += ru;
            g.rolloverWETH = 0;
            g.rolloverUSDC = 0;
            emit RolloverInjected(id, rw, ru);
        }

        uint256 winConv = e.winningConvictionSum;

        // ---- step 2: R-cap. Distributable pot <= 2*winningConvictionSum (excess rolls). ----
        uint256 cap = 2 * winConv;
        if (e.potUSDC > cap) {
            uint256 excessUSDC = e.potUSDC - cap;
            e.potUSDC = cap;
            g.rolloverUSDC += excessUSDC;
            emit SubsidyCapped(id, cap, excessUSDC);
        }

        // ---- step 3: BURN losing-side conviction to TREASURY (excluded from need). ----
        uint256 burned = _losersConviction(e);
        e.burnedConviction = burned;

        // ---- step 4: freeze the sqrt-weighted denominator; empty/all-dust => roll forward. ----
        uint256 denom = e.winnerSqrtConvSum;
        if (denom == 0) {
            e.rolledOver = true;
            g.rolloverWETH += e.potWETH;
            g.rolloverUSDC += e.potUSDC;
            emit EmptyWinnerRollover(id, e.winningSide, e.potWETH, e.potUSDC);
        } else {
            e.winnerDenominator = denom;
        }

        // ---- step 5: O(1) counters. ----
        if (!e.rolledOver) {
            g.totalOwedWETH += e.potWETH;
            g.totalOwedUSDC += e.potUSDC;
        }
        g.totalOwedUSDC += winConv; // winning-side conviction becomes refundable (owed)
        g.totalCustodiedConviction -= (winConv + burned); // leaves live custody
        g.totalCommittedSubsidy -= e.subsidyUSDC; // committed R folds into the owed pot

        e.phase = IFeeArena.Phase.Settled;
        emit EpochSettled(id, e.winningSide, e.winnerDenominator, e.potWETH, e.potUSDC);

        // BURN transfer LAST (blocklist-resilient).
        if (burned > 0) {
            g.totalLedgerUSDC += payoutUSDC(owedUSDC, treasury, burned);
            emit ConvictionBurned(id, burned);
        }
    }

    /// @dev Sum of conviction on the two LOSING sides of a resolved epoch (the winning side's
    ///      conviction is already frozen in `winningConvictionSum` at sweep). O(1) over the 4-entry
    ///      `sideConviction` array (NONE unused).
    function _losersConviction(EpochV2 storage e) private view returns (uint256 burned) {
        uint8 w = uint8(e.winningSide);
        for (uint8 s = uint8(IFeeArena.Side.UP); s <= uint8(IFeeArena.Side.RANGE); ++s) {
            if (s != w) burned += e.sideConviction[s];
        }
    }

    // =====================================================================
    // CLAIM - sqrt-weighted pot share (decoupled from principal).
    // =====================================================================

    /// @dev The full body of FeeArenaV2.claim: CHECKS + sqrt floor math + EFFECTS + the
    ///      (blocklist-resilient) mixed payout + Claimed event, writing the {Globals} counters
    ///      directly. `to` is the resolved recipient (recipient ?? owner). CEI: effects precede pay.
    function claim(
        EpochV2 storage e,
        Position storage p,
        Globals storage g,
        mapping(address => uint256) storage owedUSDC,
        mapping(address => uint256) storage owedWETH,
        uint64 epochId,
        uint256 tokenId,
        address to
    ) public {
        if (e.phase != IFeeArena.Phase.Settled) {
            revert IFeeArena.NotSettled();
        }
        if (e.rolledOver) revert IFeeArena.AlreadyRolledOver();
        if (e.sweepCursor != e.stakedCount) revert IFeeArena.SweepNotComplete();

        if (p.epochId != epochId) revert WrongEpoch();
        if (p.side != e.winningSide) revert IFeeArena.WrongSide();
        if (p.claimed) revert IFeeArena.AlreadyClaimed();
        if (p.contribution6 == 0) revert IFeeArena.NothingToClaim();

        uint256 denom = e.winnerDenominator; // == winnerSqrtConvSum
        if (denom == 0) revert IFeeArena.NothingToClaim();

        uint256 weight = Math.sqrt(p.conviction);
        uint256 payWETH = Math.mulDiv(e.potWETH, weight, denom); // floor
        uint256 payUSDC = Math.mulDiv(e.potUSDC, weight, denom); // floor (potUSDC incl. capped R)

        // EFFECTS FIRST (CEI).
        p.claimed = true;
        e.claimedWETH += payWETH;
        e.claimedUSDC += payUSDC;
        e.claimedCount += 1;
        g.totalOwedWETH -= payWETH;
        g.totalOwedUSDC -= payUSDC;

        // INTERACTION LAST: blocklist-resilient.
        (uint256 lw, uint256 lu) = payout(owedUSDC, owedWETH, to, payWETH, payUSDC);
        g.totalLedgerWETH += lw;
        g.totalLedgerUSDC += lu;
        emit Claimed(epochId, p.owner, tokenId, payWETH, payUSDC);
    }

    // =====================================================================
    // REFUND - winning-side conviction principal 1:1 (decoupled).
    // =====================================================================

    /// @dev The full body of FeeArenaV2.refundConviction: CHECKS + EFFECTS + the (blocklist-resilient)
    ///      USDC refund + ConvictionRefunded event, writing the {Globals} counters directly.
    function refundConviction(
        EpochV2 storage e,
        Position storage p,
        Globals storage g,
        mapping(address => uint256) storage owedUSDC,
        uint64 epochId,
        address to,
        uint256 tokenId
    ) public {
        if (e.phase != IFeeArena.Phase.Settled) revert IFeeArena.NotSettled();
        if (p.epochId != epochId) revert WrongEpoch();
        if (p.side != e.winningSide) revert NotRefundable();
        if (p.convictionRefunded) revert AlreadyRefunded();

        uint256 c = p.conviction;
        // EFFECTS FIRST (CEI): exact 1:1, no mulDiv, no division.
        p.convictionRefunded = true;
        e.refundedConviction += c;
        e.convRefundedCount += 1;
        g.totalOwedUSDC -= c;

        // INTERACTION LAST: blocklist-resilient.
        g.totalLedgerUSDC += payoutUSDC(owedUSDC, to, c);
        emit ConvictionRefunded(epochId, p.owner, tokenId, c);
    }

    // =====================================================================
    // FOLD DUST - floor-residual pot dust forward (conviction never touched).
    // =====================================================================

    /// @dev The full body of FeeArenaV2.foldDust: CHECKS + EFFECTS + DustFolded event, writing the
    ///      {Globals} counters directly. `winners` is winnerCount[epochId].
    function foldDust(EpochV2 storage e, Globals storage g, uint64 epochId, uint32 winners) public {
        if (e.phase != IFeeArena.Phase.Settled) revert IFeeArena.NotSettled();
        if (e.rolledOver) revert IFeeArena.AlreadyRolledOver();
        if (e.claimedCount != winners) revert IFeeArena.NotAllClaimed();

        uint256 dustWETH = e.potWETH - e.claimedWETH; // exact, from counters
        uint256 dustUSDC = e.potUSDC - e.claimedUSDC;
        if (dustWETH == 0 && dustUSDC == 0) revert IFeeArena.NothingToFold();

        // drain the residual via counters so a second call has nothing left to fold.
        e.claimedWETH = e.potWETH;
        e.claimedUSDC = e.potUSDC;
        g.totalOwedWETH -= dustWETH;
        g.totalOwedUSDC -= dustUSDC;
        g.rolloverWETH += dustWETH;
        g.rolloverUSDC += dustUSDC;
        emit DustFolded(epochId, dustWETH, dustUSDC);
    }

    // =====================================================================
    // EMERGENCY - terminal escape hatch for a genuinely-unresolved epoch.
    // =====================================================================

    /// @dev The full body of FeeArenaV2.emergencySettle: gate checks, refund conviction 1:1 to ALL
    ///      stakers (both sides, blocklist-resilient) + mark swept, inject any pending rollover once,
    ///      roll the realized pot + R forward - writing the {Globals} counters DIRECTLY + emitting
    ///      EmergencyConvictionRefunded / RolloverInjected / EmergencySettled. The arena wrapper sets
    ///      lastSettledEpochId + calls _assertSolvent after.
    function emergencySettle(
        EpochV2 storage e,
        Globals storage g,
        mapping(uint256 => Position) storage positions,
        mapping(uint64 => uint256[]) storage epochTokenIds,
        mapping(address => uint256) storage owedUSDC,
        uint64 epochId,
        IFeeArena.Side resolution
    ) public {
        if (e.phase == IFeeArena.Phase.Settled || e.phase == IFeeArena.Phase.None) revert IFeeArena.WrongPhase();
        if (e.settlePrice18 != 0) revert EpochResolvable();
        if (block.timestamp <= uint256(e.endTime) + GRACE) revert IFeeArena.GraceNotElapsed();
        if (e.rolloverConsumed) revert IFeeArena.RolloverAlreadyConsumed();

        // Refund conviction 1:1 to ALL stakers (both sides) + mark swept (bounded by maxStakesPerEpoch).
        uint256[] storage ids = epochTokenIds[epochId];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; ++i) {
            _emergencyRefundOne(positions, g, owedUSDC, epochId, ids[i]);
        }
        e.sweepCursor = e.stakedCount;
        e.winningSide = resolution; // recorded for the event only; pot is rolled, not divided.

        // Inject pending rollover once, then roll the whole pot + R forward.
        e.rolloverConsumed = true;
        uint256 rw = g.rolloverWETH;
        uint256 ru = g.rolloverUSDC;
        if (rw != 0 || ru != 0) {
            e.potWETH += rw;
            e.potUSDC += ru;
            g.rolloverWETH = 0;
            g.rolloverUSDC = 0;
            emit RolloverInjected(epochId, rw, ru);
        }
        e.rolledOver = true;
        g.rolloverWETH += e.potWETH;
        g.rolloverUSDC += e.potUSDC;
        if (e.subsidyUSDC > 0) g.totalCommittedSubsidy -= e.subsidyUSDC;

        e.phase = IFeeArena.Phase.Settled;
        emit EmergencySettled(epochId, resolution);
    }

    /// @dev Emergency-refund ONE position's conviction 1:1 (both sides) + mark swept. EFFECTS before
    ///      the (blocklist-resilient) payout; idempotent via `convictionRefunded`. Returns the custody
    ///      decrement + any ledger add (blocked send).
    function _emergencyRefundOne(
        mapping(uint256 => Position) storage positions,
        Globals storage g,
        mapping(address => uint256) storage owedUSDC,
        uint64 epochId,
        uint256 tokenId
    ) private {
        Position storage p = positions[tokenId];
        p.swept = true; // NFT becomes unstakeable once the epoch is Settled.
        if (p.convictionRefunded) return; // idempotent (defensive; loop visits each once).
        uint256 c = p.conviction;

        // EFFECTS FIRST (CEI): mark refunded + retire its live custody.
        p.convictionRefunded = true;
        if (c > 0) {
            g.totalCustodiedConviction -= c;
            g.totalLedgerUSDC += payoutUSDC(owedUSDC, p.owner, c); // blocklist-resilient
            emit EmergencyConvictionRefunded(epochId, p.owner, tokenId, c);
        }
    }

    event EmergencyConvictionRefunded(
        uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, uint256 amount
    );
    error EpochResolvable();

    // =====================================================================
    // C3 BLOCKLIST-RESILIENT PAYOUT HELPERS (moved out of the arena; same event topic).
    // Under delegatecall these run in the arena's context: `address(this)` is the arena,
    // so the self-only externalTransfer* guard holds and emitted events come FROM the arena.
    // =====================================================================

    /// @dev Mixed (WETH+USDC) payout. Both legs are blocklist-resilient: a failed send credits the
    ///      recipient's owed* ledger (+ the O(1) aggregate) instead of reverting, so the caller's
    ///      EFFECTS hold and foldDust's counters can never be bricked by a blocked winner.
    function payout(
        mapping(address => uint256) storage owedUSDC,
        mapping(address => uint256) storage owedWETH,
        address to,
        uint256 wethAmt,
        uint256 usdcAmt
    ) public returns (uint256 ledgerWETHAdd, uint256 ledgerUSDCAdd) {
        ledgerWETHAdd = payoutWETH(owedWETH, to, wethAmt);
        ledgerUSDCAdd = payoutUSDC(owedUSDC, to, usdcAmt);
    }

    /// @dev Blocklist-resilient USDC send: on a failed transfer, credit owedUSDC[to] + emit
    ///      PayoutDeferred instead of reverting. Returns the amount to add to totalLedgerUSDC.
    function payoutUSDC(mapping(address => uint256) storage owedUSDC, address to, uint256 amount)
        public
        returns (uint256 ledgerUSDCAdd)
    {
        if (amount == 0) return 0;
        try IArenaTransfer(address(this)).externalTransferUSDC(to, amount) {
        // sent successfully
        }
        catch {
            owedUSDC[to] += amount;
            emit PayoutDeferred(to, amount, 0);
            return amount;
        }
    }

    /// @dev Blocklist-resilient WETH send (symmetric to payoutUSDC). Returns the totalLedgerWETH add.
    function payoutWETH(mapping(address => uint256) storage owedWETH, address to, uint256 amount)
        public
        returns (uint256 ledgerWETHAdd)
    {
        if (amount == 0) return 0;
        try IArenaTransfer(address(this)).externalTransferWETH(to, amount) {
        // sent successfully
        }
        catch {
            owedWETH[to] += amount;
            emit PayoutDeferred(to, 0, amount);
            return amount;
        }
    }

    event PayoutDeferred(address indexed to, uint256 usdcAmt, uint256 wethAmt);

    // ---- events emitted by the moved logic (same topics as the arena's; under delegatecall they
    //      are logged FROM the arena address). The IFeeArena-inherited ones are re-declared here so
    //      the library can `emit` them; the v2-only ones mirror the arena's declarations. ----
    event EpochSettled(
        uint64 indexed epochId, IFeeArena.Side winningSide, uint256 winnerDenominator, uint256 potWETH, uint256 potUSDC
    );
    event RolloverInjected(uint64 indexed epochId, uint256 wethIn, uint256 usdcIn);
    event EmptyWinnerRollover(uint64 indexed epochId, IFeeArena.Side winningSide, uint256 potWETH, uint256 potUSDC);
    event Claimed(
        uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, uint256 payWETH, uint256 payUSDC
    );
    event DustFolded(uint64 indexed epochId, uint256 dustWETH, uint256 dustUSDC);
    event EmergencySettled(uint64 indexed epochId, IFeeArena.Side resolution);
    event SubsidyCapped(uint64 indexed epochId, uint256 distributablePot, uint256 rolledExcess);
    event ConvictionBurned(uint64 indexed epochId, uint256 burnedConviction);
    event ConvictionRefunded(uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, uint256 amount);

    // ---- v2 errors that live with the moved logic (mirror the arena's). ----
    error WrongEpoch();
    error NotRefundable();
    error AlreadyRefunded();
}
