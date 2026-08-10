// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";
import {WETH9} from "src/mocks/WETH9.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";

/// @notice Bounded actor driving createEpoch -> stake -> start -> end -> sweep -> finalize ->
///         claim -> foldDust -> unstake across >=3 sequential epochs (including empty-winner
///         chains). Permissionless cranks legitimately revert on precondition; every action is
///         try/catch so only the `invariant_*` asserts in the suite contracts can fail a run.
///         Ghost vars track external truth (never read from contract internals for the totals).
///
/// @dev FUNDING MODEL (CRITICAL): the MockNPM.collect() does NOT move real tokens (it just
///      returns owed and zeroes it), but FeeArena._assertSolvent() checks the REAL balanceOf
///      on every state change. So whenever fees are seeded onto a staked position, this handler
///      ALSO funds the vault with the same amount (mirror of FeeArenaTestBase._programOwed /
///      _fundVault). Without that, the contract's own solvency assertion reverts inside the
///      action (caught), the pot never grows, and the invariants pass trivially.
contract FeeArenaHandler is Test {
    FeeArena public immutable arena;
    MockPriceOracle public immutable oracle;
    MockNonfungiblePositionManager public immutable npm;
    address public immutable weth;
    address public immutable usdc;
    address public immutable pool;
    uint24 public immutable feeTier;
    uint128 public immutable minLiquidity;
    address public immutable owner;

    // EPOCHS storage slot of FeeArena (verified by FeeArenaTestBase slot tests). Used to read
    // the Epoch fields not projected by getEpoch()'s EpochView (claimed counters + the
    // rolloverConsumed guard).
    uint256 internal constant EPOCHS_SLOT = 3;

    // Actors
    address[] public actors;
    mapping(address => bool) internal isActor;

    // Ghost accounting (external truth, never reads contract internals for the totals)
    uint256 public ghost_feesSeededWETH; // total WETH fees ever made collectable on staked positions
    uint256 public ghost_feesSeededUSDC;
    uint256 public ghost_feesSeededWETHSwept; // WETH actually collected into the vault by sweep
    uint256 public ghost_feesSeededUSDCSwept;
    uint256 public ghost_paidWETH; // total WETH paid out via claim
    uint256 public ghost_paidUSDC;
    uint256 public ghost_emptyRolloverWETH; // pot amounts that went to rollover via empty-winner
    uint256 public ghost_emptyRolloverUSDC;

    // Per-epoch realized-claim mirror (so Solvency can recompute pot - claimed without reading
    // the internal `epochs` mapping). Drained to "fully claimed" when foldDust runs.
    mapping(uint64 => uint256) public ghost_epochClaimedWETH;
    mapping(uint64 => uint256) public ghost_epochClaimedUSDC;
    mapping(uint64 => bool) public ghost_epochFolded;

    // Rollover / finalize witnesses (Task I4).
    mapping(uint64 => uint8) public ghost_injectCount; // times finalizeSettle injected rollover INTO epoch id
    uint64 public ghost_lastFinalized; // monotonic finalize order witness

    // Single-payout witness (Task I5): times a tokenId's reward was realized (claimed flip 0->1).
    mapping(uint256 => uint8) public ghost_payoutCount;

    // Coverage witnesses (asserted by the suites so we know the handler reached the states).
    uint256 public ghost_epochsCreated;
    uint256 public ghost_epochsSettled;
    uint256 public ghost_emptyWinnerEpochs;
    uint256 public ghost_successfulClaims;
    uint256 public ghost_successfulUnstakes;

    // Token tracking for staked positions
    mapping(uint256 => bool) public tokenStaked; // tokenId -> currently escrowed in arena
    uint256[] public allStakedTokens; // every tokenId ever staked (for claim/unstake sweeps)

    // The current epoch id the handler is building (mirrors arena.currentEpochId()).
    uint64 public lastCreatedEpoch;

    constructor(
        FeeArena arena_,
        MockPriceOracle oracle_,
        MockNonfungiblePositionManager npm_,
        address weth_,
        address usdc_,
        address pool_,
        uint24 feeTier_,
        uint128 minLiquidity_,
        address owner_
    ) {
        arena = arena_;
        oracle = oracle_;
        npm = npm_;
        weth = weth_;
        usdc = usdc_;
        pool = pool_;
        feeTier = feeTier_;
        minLiquidity = minLiquidity_;
        owner = owner_;

        for (uint256 i = 0; i < 4; ++i) {
            address a = address(uint160(uint256(keccak256(abi.encode("arena-actor", i)))));
            actors.push(a);
            isActor[a] = true;
        }
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function allStakedTokensLength() external view returns (uint256) {
        return allStakedTokens.length;
    }

    function _boundActor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // ---- storage helpers (Epoch fields not in EpochView) ----

    /// @dev Read `claimedWETH`/`claimedUSDC` for epoch `id` from FeeArena storage.
    function _epochClaimed(uint64 id) internal view returns (uint256 claimedWETH, uint256 claimedUSDC) {
        bytes32 rowBase = keccak256(abi.encode(uint256(id), EPOCHS_SLOT));
        claimedWETH = uint256(vm.load(address(arena), bytes32(uint256(rowBase) + 13)));
        claimedUSDC = uint256(vm.load(address(arena), bytes32(uint256(rowBase) + 14)));
    }

    /// @dev Read the `rolloverConsumed` guard for epoch `id` from FeeArena storage.
    function epochRolloverConsumed(uint64 id) public view returns (bool) {
        bytes32 rowBase = keccak256(abi.encode(uint256(id), EPOCHS_SLOT));
        bytes32 slot1 = vm.load(address(arena), bytes32(uint256(rowBase) + 1));
        return ((uint256(slot1) >> (26 * 8)) & 0xff) != 0;
    }

    /// @dev Mirror the realized pot into the vault so FeeArena._assertSolvent holds. WETH is
    ///      wrapped via deposit{value}; USDC is minted (both test mocks are unrestricted).
    function _fundVault(uint256 wethAmt, uint256 usdcAmt) internal {
        if (wethAmt > 0) {
            vm.deal(address(this), address(this).balance + wethAmt);
            WETH9(payable(weth)).deposit{value: wethAmt}();
            WETH9(payable(weth)).transfer(address(arena), wethAmt);
        }
        if (usdcAmt > 0) {
            TestERC20(usdc).mint(address(arena), usdcAmt);
        }
    }

    /// @dev Set owed fees on a staked position (ordered by the pool's token layout) AND fund the
    ///      vault by the same amount. Funding happens BEFORE any sweep collects the position, so
    ///      FeeArena._assertSolvent (run inside sweep) always sees balance >= pot. Mirrors
    ///      FeeArenaTestBase._programOwed exactly. Ghosts record the seeded WETH/USDC totals.
    function _seedAndFund(uint256 tokenId, uint256 owedWeth, uint256 owedUsdc) internal {
        if (arena.wethIsToken0() == 1) {
            npm.setOwed(tokenId, uint128(owedWeth), uint128(owedUsdc));
        } else {
            npm.setOwed(tokenId, uint128(owedUsdc), uint128(owedWeth));
        }
        _fundVault(owedWeth, owedUsdc);
        ghost_feesSeededWETH += owedWeth;
        ghost_feesSeededUSDC += owedUsdc;
    }

    // =====================================================================
    // Lifecycle actions (Task I2). Every external call is try/catch-guarded:
    // permissionless cranks legitimately revert on precondition, so only the
    // suite-level invariant_* asserts may fail a run.
    // =====================================================================

    /// @dev Ensure an EntryOpen epoch exists; create+open one if the previous is Settled (or
    ///      this is the very first epoch). Sequential-V0: createEpoch reverts unless the prior
    ///      epoch is Settled.
    function _ensureEntryOpen() internal {
        uint64 cur = arena.currentEpochId();
        if (cur == 0) {
            try arena.createEpoch() returns (uint64 id) {
                lastCreatedEpoch = id;
                ghost_epochsCreated += 1;
            } catch {
                return;
            }
            try arena.openEntry() {} catch {}
            return;
        }
        IFeeArena.EpochView memory e = arena.getEpoch(cur);
        if (e.phase == IFeeArena.PhaseView.Settled) {
            try arena.createEpoch() returns (uint64 id) {
                lastCreatedEpoch = id;
                ghost_epochsCreated += 1;
            } catch {
                return;
            }
            try arena.openEntry() {} catch {}
        } else if (e.phase == IFeeArena.PhaseView.Idle) {
            // created but not opened (currentEpoch's Phase.None collapses to Idle)
            try arena.openEntry() {} catch {}
        }
    }

    /// @notice Mint a fresh V3 position to an actor, stake it with a fuzzed side during EntryOpen,
    ///         seed fuzzed fees + fund the vault, then nudge toward start.
    function actStakeAndAdvance(uint256 actorSeed, uint8 sideRaw, uint128 liq, uint128 feeW, uint128 feeU) external {
        _ensureEntryOpen();
        uint64 cur = arena.currentEpochId();
        if (cur == 0) return;
        IFeeArena.EpochView memory e = arena.getEpoch(cur);
        if (e.phase != IFeeArena.PhaseView.EntryOpen) {
            _tryStartIfDue(cur);
            return;
        }
        // entry window may already be closed by warps; honor the strict `<` close guard.
        if (block.timestamp >= uint256(e.entryCloseTime)) {
            _tryStartIfDue(cur);
            return;
        }

        address actor = _boundActor(actorSeed);
        // side in [UP,DOWN,RANGE] = 1..3
        uint8 s = uint8(bound(uint256(sideRaw), 1, 3));
        uint128 liquidity = uint128(bound(uint256(liq), minLiquidity, minLiquidity + 1e24));

        uint256 tokenId = npm.mintTo(actor, weth, usdc, feeTier, liquidity);

        vm.roll(block.number + 1); // satisfy one-action-per-block guard for this actor
        vm.prank(actor);
        try npm.safeTransferFrom(actor, address(arena), tokenId, abi.encode(IFeeArena.Side(s))) {
            tokenStaked[tokenId] = true;
            allStakedTokens.push(tokenId);
            // seed fees + fund vault BEFORE this epoch can be swept (mirrors _programOwed).
            uint256 owedWeth = bound(uint256(feeW), 0, 100e18);
            uint256 owedUsdc = bound(uint256(feeU), 0, 200_000e6);
            _seedAndFund(tokenId, owedWeth, owedUsdc);
        } catch {
            // window closed / one-side-per-LP / caps — leave token unstaked, actor keeps it.
        }
    }

    /// @notice Top up collectable fees on an already-staked, not-yet-swept position so sweep
    ///         realizes a larger pot. ADDITIVE: reads current owed, seeds current+delta, and funds
    ///         ONLY the delta (current owed was funded when it was first seeded). This never drops
    ///         un-swept owed (which would break conservation). No-op once the position is swept.
    function actSeedFees(uint256 tokenSeed, uint128 a0, uint128 a1) external {
        uint256 n = allStakedTokens.length;
        if (n == 0) return;
        uint256 tokenId = allStakedTokens[tokenSeed % n];
        if (!tokenStaked[tokenId]) return;

        IFeeArena.StakeView memory sv = arena.getStake(tokenId);
        if (sv.swept) return; // owed already collected; topping up would never be swept
        IFeeArena.EpochView memory e = arena.getEpoch(sv.epochId);
        // only positions whose epoch can still be swept (not yet Settled)
        if (e.phase == IFeeArena.PhaseView.Settled) return;

        uint256 addWeth = bound(uint256(a0), 0, 50e18);
        uint256 addUsdc = bound(uint256(a1), 0, 100_000e6);
        if (addWeth == 0 && addUsdc == 0) return;

        // read current owed (token0/token1 order), seed current+delta, fund only the delta.
        (,,,,,,,,,, uint128 owed0, uint128 owed1) = npm.positions(tokenId);
        (uint256 curWeth, uint256 curUsdc) =
            arena.wethIsToken0() == 1 ? (uint256(owed0), uint256(owed1)) : (uint256(owed1), uint256(owed0));

        uint256 newWeth = curWeth + addWeth;
        uint256 newUsdc = curUsdc + addUsdc;
        if (arena.wethIsToken0() == 1) {
            npm.setOwed(tokenId, uint128(newWeth), uint128(newUsdc));
        } else {
            npm.setOwed(tokenId, uint128(newUsdc), uint128(newWeth));
        }
        _fundVault(addWeth, addUsdc); // delta only
        ghost_feesSeededWETH += addWeth;
        ghost_feesSeededUSDC += addUsdc;
    }

    /// @dev Warp to entryClose (within maxStartDelay) and try to start the current epoch.
    function _tryStartIfDue(uint64 id) internal {
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        if (e.phase != IFeeArena.PhaseView.EntryOpen) return;
        if (block.timestamp < uint256(e.entryCloseTime)) {
            vm.warp(uint256(e.entryCloseTime) + 1);
        }
        oracle.setPrice(3000e18); // fresh, > 0 (handler owns the oracle)
        try arena.startEpoch(new bytes[](0)) {} catch {}
    }

    /// @notice Warp past endTime, set the settle price (fuzzed to hit UP/DOWN/RANGE incl. the
    ///         empty-winner branch when no staker chose the winning side), and resolve.
    function actEndAndResolve(uint8 priceMode) external {
        uint64 cur = arena.currentEpochId();
        if (cur == 0) return;
        IFeeArena.EpochView memory e = arena.getEpoch(cur);
        if (e.phase == IFeeArena.PhaseView.EntryOpen) {
            _tryStartIfDue(cur);
            return;
        }
        if (e.phase != IFeeArena.PhaseView.Running) return;
        if (block.timestamp < uint256(e.endTime)) {
            vm.warp(uint256(e.endTime) + 1);
        }
        // startPrice frozen at 3000e18; pick a settle price by mode to drive the band branch.
        uint256 settle;
        uint8 m = uint8(priceMode % 3);
        if (m == 0) {
            settle = 3100e18; // +3.33% -> UP
        } else if (m == 1) {
            settle = 2900e18; // -3.33% -> DOWN
        } else {
            settle = 3000e18; // 0% -> RANGE
        }
        oracle.setPrice(settle);
        bytes[] memory pd = new bytes[](0);
        try arena.endEpoch(pd) {} catch {}
    }

    /// @notice Paginated sweep of the current epoch. Self-advances the lifecycle first (start +
    ///         end if the epoch is still EntryOpen/Running) so a single call reliably makes
    ///         progress toward Settled — this lets a 64-deep sequence chain >=3 epochs without
    ///         relying on the fuzzer to emit the cranks in perfect order. Tracks swept-in fees by
    ///         diffing pot before/after (Conservation truth: only SWEPT fees enter the vault).
    function actSweep(uint256 maxSeed) external {
        uint64 cur = arena.currentEpochId();
        if (cur == 0) return;
        _advanceToResolved(cur);
        uint256 maxCount = bound(maxSeed, 1, 8);
        IFeeArena.EpochView memory be = arena.getEpoch(cur);
        try arena.sweep(maxCount) {
            IFeeArena.EpochView memory ae = arena.getEpoch(cur);
            ghost_feesSeededWETHSwept += ae.potWETH - be.potWETH;
            ghost_feesSeededUSDCSwept += ae.potUSDC - be.potUSDC;
        } catch {}
    }

    /// @dev Push the current epoch EntryOpen -> Running -> Resolved if it is due, so downstream
    ///      cranks (sweep/finalize) have something to act on. Each step is try/catch guarded. The
    ///      settle outcome cycles UP/DOWN/RANGE by epoch id so self-advancing does NOT bias every
    ///      epoch to one branch — combined with stakers' fuzzed sides this yields both normal
    ///      winners (claims) and empty winners (rollover) across the chain.
    function _advanceToResolved(uint64 id) internal {
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        if (e.phase == IFeeArena.PhaseView.EntryOpen) {
            _tryStartIfDue(id);
            e = arena.getEpoch(id);
        }
        if (e.phase == IFeeArena.PhaseView.Running) {
            if (block.timestamp < uint256(e.endTime)) vm.warp(uint256(e.endTime) + 1);
            oracle.setPrice(_settlePriceFor(id));
            bytes[] memory pd = new bytes[](0);
            try arena.endEpoch(pd) {} catch {}
        }
    }

    /// @dev A settle price that resolves to UP/DOWN/RANGE by epoch id (start frozen at 3000e18).
    function _settlePriceFor(uint64 id) internal pure returns (uint256) {
        uint256 m = uint256(id) % 3;
        if (m == 0) return 3100e18; // +3.33% -> UP
        if (m == 1) return 2900e18; // -3.33% -> DOWN
        return 3000e18; // RANGE
    }

    /// @dev Sweep the current epoch to completion (drains the cursor), tracking swept-in fees.
    function _sweepAll() internal {
        uint64 cur = arena.currentEpochId();
        if (cur == 0) return;
        for (uint256 k = 0; k < 64; ++k) {
            IFeeArena.EpochView memory be = arena.getEpoch(cur);
            if (be.phase != IFeeArena.PhaseView.Running && be.sweepCursor == be.stakedCount) {
                // already Swept/Settled or nothing left
            }
            try arena.sweep(8) {
                IFeeArena.EpochView memory ae = arena.getEpoch(cur);
                ghost_feesSeededWETHSwept += ae.potWETH - be.potWETH;
                ghost_feesSeededUSDCSwept += ae.potUSDC - be.potUSDC;
                if (ae.sweepCursor == ae.stakedCount) break; // fully swept
            } catch {
                break; // wrong phase (not Resolved) — nothing to sweep
            }
        }
    }

    /// @notice Finalize the next-in-order Swept epoch. Self-advances the current epoch through
    ///         start/end/sweep first so finalize has a Swept epoch to consume — reliably chaining
    ///         epochs to Settled. Records the empty-winner rollover-out and the exactly-once
    ///         injection witness (full assertions live in I4's suite).
    function actFinalize() external {
        uint64 cur = arena.currentEpochId();
        if (cur != 0) {
            _advanceToResolved(cur);
            _sweepAll();
        }
        uint64 id = arena.lastSettledEpochId() + 1;
        IFeeArena.EpochView memory before_ = arena.getEpoch(id);
        uint256 rollWbefore = arena.rolloverWETH();
        uint256 rollUbefore = arena.rolloverUSDC();
        bool hadPending = (rollWbefore > 0 || rollUbefore > 0);

        try arena.finalizeSettle() {
            ghost_epochsSettled += 1;
            // exactly-once injection witness: rolloverConsumed must be true post-finalize.
            if (hadPending && epochRolloverConsumed(id)) ghost_injectCount[id] += 1;

            // in-order finalize witnesses (Task I4): finalizeSettle must consume epochs strictly
            // sequentially with no gaps/repeats, and must advance lastSettledEpochId to `id`.
            assertEq(arena.lastSettledEpochId(), id, "finalize set lastSettledEpochId off");
            assertEq(id, ghost_lastFinalized + 1, "finalize out of order");
            ghost_lastFinalized = id;

            IFeeArena.EpochView memory after_ = arena.getEpoch(id);
            if (after_.rolledOver && !before_.rolledOver) {
                ghost_emptyRolloverWETH += after_.potWETH;
                ghost_emptyRolloverUSDC += after_.potUSDC;
                ghost_emptyWinnerEpochs += 1;
            }
        } catch {}
    }

    /// @notice Claim a settled winner's payout. Records realized payouts into the ghost mirrors
    ///         (per-epoch + global) by diffing the claimed counters across the call, and counts
    ///         the at-most-once payout flip per token (Task I5).
    function actClaim(uint256 tokenSeed) external {
        uint256 n = allStakedTokens.length;
        if (n == 0) return;
        uint256 tokenId = allStakedTokens[tokenSeed % n];
        IFeeArena.StakeView memory sv = arena.getStake(tokenId);
        uint64 id = sv.epochId;
        if (id == 0) return;
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        if (e.phase != IFeeArena.PhaseView.Settled || e.rolledOver) return;

        bool wasClaimed = sv.claimed;
        (uint256 cwBefore, uint256 cuBefore) = _epochClaimed(id);
        try arena.claim(id, tokenId) {
            (uint256 cwAfter, uint256 cuAfter) = _epochClaimed(id);
            uint256 dW = cwAfter - cwBefore;
            uint256 dU = cuAfter - cuBefore;
            ghost_paidWETH += dW;
            ghost_paidUSDC += dU;
            ghost_epochClaimedWETH[id] += dW;
            ghost_epochClaimedUSDC[id] += dU;

            IFeeArena.StakeView memory after_ = arena.getStake(tokenId);
            if (!wasClaimed && after_.claimed) {
                ghost_payoutCount[tokenId] += 1;
                ghost_successfulClaims += 1;
            }
        } catch {}
    }

    /// @notice Fold floor-residual dust forward once every winner has claimed. After a successful
    ///         fold, the epoch's pot is fully accounted (claimed == pot, residual moved to the
    ///         global rollover), so mirror that in the ghost so Solvency stops counting it.
    function actFoldDust(uint256 idSeed) external {
        uint64 last = arena.currentEpochId();
        if (last == 0) return;
        uint64 id = uint64(bound(idSeed, 1, last));
        IFeeArena.EpochView memory be = arena.getEpoch(id);
        try arena.foldDust(id) {
            // residual (pot - claimed) was rolled out; mirror "fully claimed" so the Solvency
            // invariant no longer expects the vault to hold this epoch's leftover.
            ghost_epochClaimedWETH[id] = be.potWETH;
            ghost_epochClaimedUSDC[id] = be.potUSDC;
            ghost_epochFolded[id] = true;
        } catch {}
    }

    /// @notice Unstake a settled, swept position. Reward payout is a SEPARATE two-step claim()
    ///         in V0 (not auto-claimed here), but guard the at-most-once flip anyway so the
    ///         single-payout property is robust to either ordering (Task I5).
    function actUnstake(uint256 tokenSeed) external {
        uint256 n = allStakedTokens.length;
        if (n == 0) return;
        uint256 tokenId = allStakedTokens[tokenSeed % n];
        if (!tokenStaked[tokenId]) return;
        IFeeArena.StakeView memory sv = arena.getStake(tokenId);
        uint64 id = sv.epochId;
        if (id == 0) return;
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        if (e.phase != IFeeArena.PhaseView.Settled) return;

        bool wasClaimed = sv.claimed;
        address tokenOwner = sv.owner;
        vm.prank(tokenOwner);
        try arena.unstake(tokenId) {
            tokenStaked[tokenId] = false;
            ghost_successfulUnstakes += 1;
            IFeeArena.StakeView memory after_ = arena.getStake(tokenId);
            if (!wasClaimed && after_.claimed) ghost_payoutCount[tokenId] += 1;
        } catch {}
    }
}
