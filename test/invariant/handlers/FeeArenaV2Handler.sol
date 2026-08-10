// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArenaV2} from "src/FeeArenaV2.sol";
import {FeeArenaV2Lens} from "src/FeeArenaV2Lens.sol";
import {EpochV2, Position} from "src/FeeArenaV2Types.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "src/mocks/MockPriceOracle.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";
import {WETH9} from "src/mocks/WETH9.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Bounded actor driving the FULL FeeArenaV2 conviction-parimutuel lifecycle across
///         >= 3 sequential epochs: createEpoch -> openEntry -> stakeWithConviction (USDC
///         conviction posted) -> fundSubsidy (bounded R) -> startEpoch -> endEpoch -> sweep ->
///         finalizeSettle -> refundConviction (principal, decoupled) + claim (sqrt pot share) ->
///         foldDust -> unstake. Permissionless cranks legitimately revert on precondition; every
///         action is try/catch so ONLY the suite `invariant_*` asserts can fail a run.
///
///         Ghost vars track EXTERNAL truth (never the contract's own internal totals) so the
///         solvency/conservation/conviction/payout invariants are independent of the SUT.
///
/// @dev FUNDING MODEL (CRITICAL — mirrors the v1 handler): MockNPM.collect() does NOT move real
///      tokens (it returns owed and zeroes it). The conviction USDC IS pulled by the contract
///      (real safeTransferFrom). So whenever fees are seeded onto a staked position the handler
///      ALSO funds the vault with the same amount; conviction + subsidy USDC are funded into the
///      respective payer (staker / owner) and pulled by the contract for real. Without the fee
///      mirror, _assertSolvent reverts inside the action (caught), the pot never grows, and the
///      invariants pass trivially.
///
/// @dev OPERATOR-EXCLUSION: stakeWithConviction reverts if msg.sender == owner()||keeper. The
///      handler is the arena OWNER (createEpoch/openEntry/fundSubsidy are owner-gated) and owns
///      the oracle, so stakers are DISTINCT EOAs (vm.prank). The keeper is left unset (address 0).
contract FeeArenaV2Handler is Test {
    FeeArenaV2 public immutable arena;
    FeeArenaV2Lens public immutable lens; // stateless read companion (getStake projection)
    MockPriceOracle public immutable oracle;
    MockNonfungiblePositionManager public immutable npm;
    address public immutable weth;
    address public immutable usdc;
    uint24 public immutable feeTier;
    uint128 public immutable minLiquidity;

    uint256 public immutable MIN_CONV;
    uint256 public immutable MAX_CONV;
    uint256 public immutable MAX_SUBSIDY;
    uint32 public immutable MIN_START_GAP;

    uint256 internal constant START_PRICE = 3000e18;

    // Actors (distinct from owner/keeper so operator-exclusion never blocks staking).
    address[] public actors;

    // ---- ghost accounting (external truth) ----

    // fees seeded onto staked positions + funded into the vault (both legs).
    uint256 public ghost_feesSeededWETH;
    uint256 public ghost_feesSeededUSDC;
    // conviction the handler funded + had the contract pull (live custody truth).
    uint256 public ghost_convFunded;
    // subsidy R the owner funded + had the contract pull.
    uint256 public ghost_subsidyFunded;

    // USDC/WETH actually paid OUT of the vault (claim pot-share + conviction refund + burn +
    // emergency refund + credit withdrawals). Used by conservation: in == held + out.
    uint256 public ghost_outWETH;
    uint256 public ghost_outUSDC;

    // per-epoch realized pot-claim mirror (pot-share only; conviction refunds tracked separately).
    mapping(uint64 => uint256) public ghost_epochClaimedWETH;
    mapping(uint64 => uint256) public ghost_epochClaimedUSDC;
    mapping(uint64 => bool) public ghost_epochFolded;

    // per-epoch refunded-conviction mirror (== sum of refunded c_i; INV-C1 / INV-S3).
    mapping(uint64 => uint256) public ghost_epochRefundedConv;

    // per-token witnesses: at-most-once pot claim + at-most-once principal refund (INV-E2).
    mapping(uint256 => uint8) public ghost_claimCount;
    mapping(uint256 => uint8) public ghost_refundCount;

    // per-token recorded stake facts (for the property/consistency suites).
    mapping(uint256 => uint64) public tokenEpoch;
    mapping(uint256 => IFeeArena.Side) public tokenSide;
    mapping(uint256 => uint256) public tokenConv;
    mapping(uint256 => bool) public tokenStaked; // currently escrowed
    uint256[] public allStakedTokens;

    // phase monotonicity witness per epoch (INV-E1): last observed phase, never regresses.
    mapping(uint64 => uint8) public ghost_lastPhase;

    // finalize in-order witness (INV-E1/E4).
    uint64 public ghost_lastFinalized;

    // coverage witnesses (asserted so we KNOW the handler reached the interesting states).
    uint256 public ghost_epochsCreated;
    uint256 public ghost_epochsSettled;
    uint256 public ghost_emptyWinnerEpochs;
    uint256 public ghost_successfulClaims;
    uint256 public ghost_successfulRefunds;
    uint256 public ghost_burnEvents;

    uint64 public lastCreatedEpoch;

    constructor(
        FeeArenaV2 arena_,
        MockPriceOracle oracle_,
        MockNonfungiblePositionManager npm_,
        address weth_,
        address usdc_,
        uint24 feeTier_,
        uint128 minLiquidity_,
        uint256 minConv_,
        uint256 maxConv_,
        uint256 maxSubsidy_,
        uint32 minStartGap_
    ) {
        arena = arena_;
        lens = new FeeArenaV2Lens(address(arena_));
        oracle = oracle_;
        npm = npm_;
        weth = weth_;
        usdc = usdc_;
        feeTier = feeTier_;
        minLiquidity = minLiquidity_;
        MIN_CONV = minConv_;
        MAX_CONV = maxConv_;
        MAX_SUBSIDY = maxSubsidy_;
        MIN_START_GAP = minStartGap_;

        // 4 distinct staker EOAs (never owner/keeper).
        for (uint256 i = 0; i < 4; ++i) {
            actors.push(address(uint160(uint256(keccak256(abi.encode("v2-actor", i))))));
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

    // ---- funding helpers ----

    /// @dev Mirror realized fees into the vault (WETH wrapped via deposit; USDC minted) so the
    ///      contract's _assertSolvent holds when sweep collects them.
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

    /// @dev Record + advance the phase-monotonicity witness for an epoch (INV-E1).
    function _observePhase(uint64 id) internal {
        if (id == 0) return;
        uint8 ph = uint8(arena.getEpoch(id).phase);
        require(ph >= ghost_lastPhase[id], "phase regressed");
        ghost_lastPhase[id] = ph;
    }

    // =====================================================================
    // Lifecycle actions (all try/catch — permissionless cranks may revert).
    // =====================================================================

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
        IFeeArena.Phase ph = arena.getEpoch(cur).phase;
        if (ph == IFeeArena.Phase.Settled) {
            try arena.createEpoch() returns (uint64 id) {
                lastCreatedEpoch = id;
                ghost_epochsCreated += 1;
            } catch {
                return;
            }
            try arena.openEntry() {} catch {}
        } else if (ph == IFeeArena.Phase.None) {
            try arena.openEntry() {} catch {}
        }
    }

    /// @notice Mint a fresh V3 position to an actor, post fuzzed conviction, stake on a fuzzed
    ///         side during EntryOpen, seed fuzzed fees + fund the vault.
    function actStakeAndAdvance(
        uint256 actorSeed,
        uint8 sideRaw,
        uint128 liq,
        uint128 feeW,
        uint128 feeU,
        uint256 cSeed
    ) external {
        _ensureEntryOpen();
        uint64 cur = arena.currentEpochId();
        if (cur == 0) return;
        _observePhase(cur);
        IFeeArena.Phase ph = arena.getEpoch(cur).phase;
        if (ph != IFeeArena.Phase.EntryOpen) {
            _tryStartIfDue(cur);
            return;
        }
        IFeeArena.EpochView memory ev;
        EpochV2 memory e = arena.getEpoch(cur);
        if (block.timestamp >= uint256(e.entryCloseTime)) {
            _tryStartIfDue(cur);
            return;
        }

        address actor = _boundActor(actorSeed);
        uint8 s = uint8(bound(uint256(sideRaw), 1, 3)); // UP/DOWN/RANGE
        uint128 liquidity = uint128(bound(uint256(liq), minLiquidity, minLiquidity + 1e24));
        uint256 conviction = bound(uint256(cSeed), MIN_CONV, MAX_CONV);

        uint256 tokenId = npm.mintTo(actor, weth, usdc, feeTier, liquidity);

        // fund + approve the actor's conviction.
        TestERC20(usdc).mint(actor, conviction);
        vm.prank(actor);
        TestERC20(usdc).approve(address(arena), conviction);

        vm.roll(block.number + 1); // one-action-per-block guard
        vm.prank(actor);
        try arena.stakeWithConviction(tokenId, IFeeArena.Side(s), conviction) {
            tokenStaked[tokenId] = true;
            allStakedTokens.push(tokenId);
            tokenEpoch[tokenId] = cur;
            tokenSide[tokenId] = IFeeArena.Side(s);
            tokenConv[tokenId] = conviction;
            ghost_convFunded += conviction;

            uint256 owedWeth = bound(uint256(feeW), 0, 100e18);
            uint256 owedUsdc = bound(uint256(feeU), 0, 200_000e6);
            _seedAndFund(tokenId, owedWeth, owedUsdc);
        } catch {
            // window closed / one-side-per-LP / caps — actor keeps the (unused) approval.
        }
        _observePhase(cur);
        ev; // silence unused
    }

    /// @notice Commit bounded subsidy R into the current epoch while phase < Resolved.
    function actFundSubsidy(uint256 amtSeed) external {
        uint64 cur = arena.currentEpochId();
        if (cur == 0) return;
        EpochV2 memory e = arena.getEpoch(cur);
        if (!(e.phase == IFeeArena.Phase.None || e.phase == IFeeArena.Phase.EntryOpen
                    || e.phase == IFeeArena.Phase.Running)) {
            return;
        }
        uint256 room = MAX_SUBSIDY > e.subsidyUSDC ? MAX_SUBSIDY - e.subsidyUSDC : 0;
        if (room == 0) return;
        uint256 amt = bound(amtSeed, 1, room);
        // owner == this handler funds R.
        TestERC20(usdc).mint(address(this), amt);
        TestERC20(usdc).approve(address(arena), amt);
        try arena.fundSubsidy(cur, amt) {
            ghost_subsidyFunded += amt;
        } catch {}
        _observePhase(cur);
    }

    function _tryStartIfDue(uint64 id) internal {
        EpochV2 memory e = arena.getEpoch(id);
        if (e.phase != IFeeArena.Phase.EntryOpen) return;
        if (block.timestamp < uint256(e.entryCloseTime) + MIN_START_GAP) {
            vm.warp(uint256(e.entryCloseTime) + MIN_START_GAP);
        }
        // pin window is [startTime, startTime+settleWindow]; stamp the price AT startTime.
        EpochV2 memory e2 = arena.getEpoch(id);
        vm.warp(uint256(e2.startTime));
        oracle.setPrice(START_PRICE);
        oracle.setConf(0);
        try arena.startEpoch(new bytes[](0)) {} catch {}
        _observePhase(id);
    }

    /// @notice Warp past endTime, set a settle price (cycled UP/DOWN/RANGE by epoch id so both
    ///         normal-winner and empty-winner branches are reached), and resolve.
    function actEndAndResolve(uint8) external {
        uint64 cur = arena.currentEpochId();
        if (cur == 0) return;
        EpochV2 memory e = arena.getEpoch(cur);
        if (e.phase == IFeeArena.Phase.EntryOpen) {
            _tryStartIfDue(cur);
            return;
        }
        if (e.phase != IFeeArena.Phase.Running) return;
        _advanceToResolved(cur);
        _observePhase(cur);
    }

    function _advanceToResolved(uint64 id) internal {
        EpochV2 memory e = arena.getEpoch(id);
        if (e.phase == IFeeArena.Phase.EntryOpen) {
            _tryStartIfDue(id);
            e = arena.getEpoch(id);
        }
        if (e.phase == IFeeArena.Phase.Running) {
            // settle price must be pinned in [endTime, endTime+settleWindow]; stamp AT endTime.
            vm.warp(uint256(e.endTime));
            oracle.setPrice(_settlePriceFor(id));
            oracle.setConf(0);
            try arena.endEpoch(new bytes[](0)) {} catch {}
        }
    }

    function _settlePriceFor(uint64 id) internal pure returns (uint256) {
        uint256 m = uint256(id) % 3;
        if (m == 0) return 3100e18; // +3.33% -> UP
        if (m == 1) return 2900e18; // -3.33% -> DOWN
        return 3000e18; // RANGE
    }

    /// @notice Paginated sweep; bootstraps + self-advances to Resolved first so a single call
    ///         makes progress regardless of the fuzzer's selector order.
    function actSweep(uint256 maxSeed) external {
        _ensureEntryOpen();
        uint64 cur = arena.currentEpochId();
        if (cur == 0) return;
        _advanceToResolved(cur);
        uint256 maxCount = bound(maxSeed, 1, 8);
        try arena.sweep(maxCount) {} catch {}
        _observePhase(cur);
    }

    function _sweepAll() internal {
        uint64 cur = arena.currentEpochId();
        if (cur == 0) return;
        for (uint256 k = 0; k < 64; ++k) {
            try arena.sweep(8) {
                EpochV2 memory ae = arena.getEpoch(cur);
                if (ae.sweepCursor == ae.stakedCount) break;
            } catch {
                break;
            }
        }
    }

    /// @notice Finalize the next-in-order Swept epoch; bootstraps an epoch if none exists and
    ///         self-advances the current one through start/end/sweep first so finalize reliably
    ///         has a Swept epoch to consume regardless of the fuzzer's selector order.
    function actFinalize() external {
        _ensureEntryOpen();
        uint64 cur = arena.currentEpochId();
        if (cur != 0) {
            _advanceToResolved(cur);
            _sweepAll();
        }
        uint64 id = arena.lastSettledEpochId() + 1;
        EpochV2 memory before_ = arena.getEpoch(id);
        try arena.finalizeSettle() {
            ghost_epochsSettled += 1;
            // in-order finalize witness (INV-E1/E4).
            assertEq(arena.lastSettledEpochId(), id, "finalize set lastSettledEpochId off");
            assertEq(id, ghost_lastFinalized + 1, "finalize out of order");
            ghost_lastFinalized = id;

            EpochV2 memory after_ = arena.getEpoch(id);
            if (after_.rolledOver && !before_.rolledOver) ghost_emptyWinnerEpochs += 1;
            if (after_.burnedConviction > 0) {
                // burned conviction LEFT custody to the treasury (or to its owed ledger). The
                // treasury here is an EOA (not blocked), so it is a real out-flow.
                ghost_outUSDC += after_.burnedConviction;
                ghost_burnEvents += 1;
            }
        } catch {}
        _observePhase(id);
    }

    /// @notice Claim a settled winner's sqrt-weighted pot share (decoupled from principal).
    function actClaim(uint256 tokenSeed) external {
        uint256 n = allStakedTokens.length;
        if (n == 0) return;
        uint256 tokenId = allStakedTokens[tokenSeed % n];
        uint64 id = tokenEpoch[tokenId];
        if (id == 0) return;
        EpochV2 memory e = arena.getEpoch(id);
        if (e.phase != IFeeArena.Phase.Settled || e.rolledOver) return;

        (uint256 cwBefore, uint256 cuBefore) = (e.claimedWETH, e.claimedUSDC);
        address recipient = lens.getStake(tokenId).owner;
        try arena.claim(id, tokenId, recipient) {
            EpochV2 memory ae = arena.getEpoch(id);
            uint256 dW = ae.claimedWETH - cwBefore;
            uint256 dU = ae.claimedUSDC - cuBefore;
            ghost_epochClaimedWETH[id] += dW;
            ghost_epochClaimedUSDC[id] += dU;
            ghost_outWETH += dW;
            ghost_outUSDC += dU;
            ghost_claimCount[tokenId] += 1; // INV-E2: must stay <= 1
            ghost_successfulClaims += 1;
        } catch {}
    }

    /// @notice Refund a winning position's conviction principal 1:1 (decoupled from the pot).
    function actRefund(uint256 tokenSeed) external {
        uint256 n = allStakedTokens.length;
        if (n == 0) return;
        uint256 tokenId = allStakedTokens[tokenSeed % n];
        uint64 id = tokenEpoch[tokenId];
        if (id == 0) return;
        EpochV2 memory e = arena.getEpoch(id);
        if (e.phase != IFeeArena.Phase.Settled) return;

        address recipient = lens.getStake(tokenId).owner;
        try arena.refundConviction(id, tokenId, recipient) {
            uint256 c = tokenConv[tokenId];
            ghost_epochRefundedConv[id] += c;
            ghost_outUSDC += c;
            ghost_refundCount[tokenId] += 1; // INV-E2: must stay <= 1
            ghost_successfulRefunds += 1;
        } catch {}
    }

    /// @notice Fold floor-residual pot dust forward once every positive-contribution winner claimed.
    function actFoldDust(uint256 idSeed) external {
        uint64 last = arena.currentEpochId();
        if (last == 0) return;
        uint64 id = uint64(bound(idSeed, 1, last));
        EpochV2 memory be = arena.getEpoch(id);
        try arena.foldDust(id) {
            // residual rolled out; mirror "fully claimed" so solvency stops counting it.
            ghost_epochClaimedWETH[id] = be.potWETH;
            ghost_epochClaimedUSDC[id] = be.potUSDC;
            ghost_epochFolded[id] = true;
        } catch {}
    }

    /// @notice Unstake a settled, swept position (returns the NFT; no token outflow).
    function actUnstake(uint256 tokenSeed) external {
        uint256 n = allStakedTokens.length;
        if (n == 0) return;
        uint256 tokenId = allStakedTokens[tokenSeed % n];
        if (!tokenStaked[tokenId]) return;
        uint64 id = tokenEpoch[tokenId];
        if (id == 0) return;
        EpochV2 memory e = arena.getEpoch(id);
        if (e.phase != IFeeArena.Phase.Settled) return;
        if (!lens.getStake(tokenId).swept) return;

        address tokenOwner = lens.getStake(tokenId).owner;
        vm.prank(tokenOwner);
        try arena.unstake(tokenId) {
            tokenStaked[tokenId] = false;
        } catch {}
    }
}
