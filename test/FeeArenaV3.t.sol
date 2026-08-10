// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaV3} from "src/FeeArenaV3.sol";
import {IFeeArenaV3} from "src/interfaces/IFeeArenaV3.sol";
import {FeeArenaV3TestBase} from "test/utils/FeeArenaV3TestBase.sol";
import {MockNonfungiblePositionManager} from "src/mocks/MockNonfungiblePositionManager.sol";

/// @notice A contract staker whose onERC721Received can reject — exercises the auto-return
///         park + manual-pull fallback on the v3 arena.
contract RejectingStakerV3 {
    FeeArenaV3 internal immutable arena;
    bool public accept;

    constructor(FeeArenaV3 a) {
        arena = a;
    }

    function setAccept(bool v) external {
        accept = v;
    }

    function stake(uint256 tokenId, IFeeArenaV3.Side side, uint256 expected) external {
        bytes[] memory noData;
        arena.stakeWithSide(tokenId, side, expected, 50, noData);
    }

    function pull(uint256 tokenId) external {
        arena.unstake(tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(accept, "receiver: reject");
        return 0x150b7a02;
    }
}

/// @notice ENTRY-ANCHORED mechanics (fee_arena_entry_anchored_btc_model.pdf): per-position
///         entryPrice anchors, slippage-guarded staking, anchored settlement submission,
///         batch processing with per-position outcomes, winners-keep-fees + loser-pot
///         claims, empty-winner rollover, and the carried-over auto-return.
contract FeeArenaV3Test is FeeArenaV3TestBase {
    address ali = makeAddr("ali");
    address ayse = makeAddr("ayse");
    address lpC = makeAddr("lpC");
    uint64 id;

    // =====================================================================
    // outcomeOf — the pure per-position rule (PDF §7 table + boundary rules)
    // =====================================================================

    function test_OutcomeOf_PdfTable() public view {
        // entry 100,000 / final 102,200 -> +220 bps -> UP
        (int256 ch, IFeeArenaV3.Side s) = arena.outcomeOf(100_000e18, 102_200e18, 150);
        assertEq(ch, 220);
        assertEq(uint8(s), uint8(IFeeArenaV3.Side.UP));
        // entry 100,000 / final 101,200 -> +120 bps -> RANGE
        (ch, s) = arena.outcomeOf(100_000e18, 101_200e18, 150);
        assertEq(ch, 120);
        assertEq(uint8(s), uint8(IFeeArenaV3.Side.RANGE));
        // entry 100,000 / final 98,000 -> -200 bps -> DOWN
        (ch, s) = arena.outcomeOf(100_000e18, 98_000e18, 150);
        assertEq(ch, -200);
        assertEq(uint8(s), uint8(IFeeArenaV3.Side.DOWN));
        // entry 102,000 / final 102,200 -> +19 bps (truncated from 19.6) -> RANGE
        (ch, s) = arena.outcomeOf(102_000e18, 102_200e18, 150);
        assertEq(ch, 19);
        assertEq(uint8(s), uint8(IFeeArenaV3.Side.RANGE));
    }

    function test_OutcomeOf_InclusiveBoundaries() public view {
        // EXACTLY +1.5% counts UP (inclusive)...
        (int256 ch, IFeeArenaV3.Side s) = arena.outcomeOf(100_000e18, 101_500e18, 150);
        assertEq(ch, 150);
        assertEq(uint8(s), uint8(IFeeArenaV3.Side.UP));
        // ...EXACTLY -1.5% counts DOWN (inclusive)...
        (ch, s) = arena.outcomeOf(100_000e18, 98_500e18, 150);
        assertEq(ch, -150);
        assertEq(uint8(s), uint8(IFeeArenaV3.Side.DOWN));
        // ...and one bps inside either edge is RANGE.
        (, s) = arena.outcomeOf(100_000e18, 101_490e18, 150);
        assertEq(uint8(s), uint8(IFeeArenaV3.Side.RANGE));
        (, s) = arena.outcomeOf(100_000e18, 98_510e18, 150);
        assertEq(uint8(s), uint8(IFeeArenaV3.Side.RANGE));
    }

    // =====================================================================
    // Staking — the entry anchor
    // =====================================================================

    function test_Stake_RecordsOwnEntryAnchor() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.UP, P100K);
        _stakeAt(ayse, IFeeArenaV3.Side.UP, 102_000e18); // later entrant, HIGHER anchor

        IFeeArenaV3.StakeView memory a = arena.getStake(_tokenIdOf(ali));
        IFeeArenaV3.StakeView memory b = arena.getStake(_tokenIdOf(ayse));
        assertEq(a.entryPrice18, P100K, "Ali anchored at his entry");
        assertEq(b.entryPrice18, 102_000e18, "Ayse anchored at HER entry (no free ride)");
        assertEq(uint8(a.side), uint8(IFeeArenaV3.Side.UP));
        assertEq(npm.ownerOf(_tokenIdOf(ali)), address(arena), "NFT escrowed");
        assertEq(arena.getEpoch(id).stakedCount, 2);
    }

    function test_Stake_DeviationGuard() public {
        id = _openEpoch();
        _setPrice(102_000e18); // the chain price moved after the user saw 100,000
        uint256 tokenId = npm.mintTo(ali, address(base), address(usdc), FEE_TIER, MIN_LIQ);
        vm.roll(block.number + 1);

        // 2% off a 100,000 expectation with a 0.5% guard -> revert, never mis-anchored
        vm.prank(ali);
        vm.expectRevert(IFeeArenaV3.EntryPriceDeviation.selector);
        arena.stakeWithSide(tokenId, IFeeArenaV3.Side.UP, P100K, 50, NO_PRICE_DATA);

        // a 3% guard accepts it — and anchors at the ACTUAL on-chain read
        vm.prank(ali);
        arena.stakeWithSide(tokenId, IFeeArenaV3.Side.UP, P100K, 300, NO_PRICE_DATA);
        assertEq(arena.getStake(tokenId).entryPrice18, 102_000e18, "anchored at actual, not expected");
    }

    function test_Stake_ZeroExpectation_Reverts() public {
        id = _openEpoch();
        _setPrice(P100K);
        uint256 tokenId = npm.mintTo(ali, address(base), address(usdc), FEE_TIER, MIN_LIQ);
        vm.roll(block.number + 1);
        vm.prank(ali);
        vm.expectRevert(IFeeArenaV3.EntryPriceDeviation.selector);
        arena.stakeWithSide(tokenId, IFeeArenaV3.Side.UP, 0, 50, NO_PRICE_DATA);
    }

    function test_StaleOracle_Reverts() public {
        // ENTRY_WINDOW(300) < MAX_PRICE_AGE(900), so an in-window stake can't see a stale
        // price with these params — assert the shared _requireFresh gate through the
        // settlement path instead: a price stamped at epoch open is stale by settlement+.
        id = _openEpoch();
        _setPrice(P100K); // updatedAt = epoch open
        vm.warp(uint256(arena.getEpoch(id).settlementTime) + uint256(MAX_PRICE_AGE));
        vm.prank(owner);
        vm.expectRevert(IFeeArenaV3.StalePrice.selector);
        arena.submitSettlementPrice(id, P100K, 0, 0, bytes32(0), NO_PRICE_DATA);
    }

    function test_Stake_RejectsDirectNftTransfer() public {
        id = _openEpoch();
        _setPrice(P100K);
        uint256 tokenId = npm.mintTo(ali, address(base), address(usdc), FEE_TIER, MIN_LIQ);
        // the v1 path (direct safeTransferFrom with side data) must NOT record a v3 stake
        vm.prank(ali);
        vm.expectRevert(IFeeArenaV3.NotNPM.selector);
        npm.safeTransferFrom(ali, address(arena), tokenId, abi.encode(uint8(1)));
    }

    function test_Stake_WindowAndGuards() public {
        id = _openEpoch();
        _setPrice(P100K);

        // same-block double stake
        uint256 t1 = npm.mintTo(ali, address(base), address(usdc), FEE_TIER, MIN_LIQ);
        uint256 t2 = npm.mintTo(ali, address(base), address(usdc), FEE_TIER, MIN_LIQ);
        vm.roll(block.number + 1);
        vm.prank(ali);
        arena.stakeWithSide(t1, IFeeArenaV3.Side.UP, P100K, 50, NO_PRICE_DATA);
        vm.prank(ali);
        vm.expectRevert(IFeeArenaV3.SameBlock.selector);
        arena.stakeWithSide(t2, IFeeArenaV3.Side.UP, P100K, 50, NO_PRICE_DATA);

        // one side per epoch
        vm.roll(block.number + 1);
        vm.prank(ali);
        vm.expectRevert(IFeeArenaV3.OneSidePerEpoch.selector);
        arena.stakeWithSide(t2, IFeeArenaV3.Side.DOWN, P100K, 50, NO_PRICE_DATA);

        // entry closes strictly at entryCloseTime
        vm.warp(arena.getEpoch(id).entryCloseTime);
        vm.roll(block.number + 1);
        vm.prank(ali);
        vm.expectRevert(IFeeArenaV3.NotEntryWindow.selector);
        arena.stakeWithSide(t2, IFeeArenaV3.Side.UP, P100K, 50, NO_PRICE_DATA);
    }

    // =====================================================================
    // THE PDF SCENARIO — Ali early, Ayşe late, same side, opposite outcomes
    // =====================================================================

    function test_PerPosition_Outcomes_AliEarly_AyseLate() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.UP, P100K); //   Ali anchors at 100,000
        _stakeAt(ayse, IFeeArenaV3.Side.UP, 102_000e18); // Ayşe anchors at 102,000
        _programOwed(_tokenIdOf(ali), 0, 100e6); //   $100 of fees
        _programOwed(_tokenIdOf(ayse), 0, 60e6); //   $60 of fees

        _settleProcessFinalize(102_200e18); // final: +2.2% for Ali, +0.19% for Ayşe

        IFeeArenaV3.StakeView memory a = arena.getStake(_tokenIdOf(ali));
        IFeeArenaV3.StakeView memory b = arena.getStake(_tokenIdOf(ayse));
        assertTrue(a.won, "Ali's UP was correct vs HIS anchor (+220 bps)");
        assertFalse(b.won, "Ayse's UP was wrong vs HER anchor (+19 bps -> RANGE)");

        // Ayşe forfeits her $60 of fees into the pot; Ali (sole winner) claims his own
        // $100 PLUS the whole $60 pot.
        IFeeArenaV3.EpochView memory e = arena.getEpoch(id);
        assertEq(e.potUSDC, 60e6, "loser fees fund the pot");
        assertEq(e.winnerCount, 1);

        arena.claim(_tokenIdOf(ali));
        assertEq(usdc.balanceOf(ali), 160e6, "own fees + whole loser pot");

        vm.expectRevert(IFeeArenaV3.NotWinner.selector);
        arena.claim(_tokenIdOf(ayse));
    }

    // =====================================================================
    // Settlement submission — gates + the on-chain anchor
    // =====================================================================

    function test_Settle_TooEarly_Reverts() public {
        id = _openEpoch();
        _setPrice(P100K);
        vm.warp(uint256(arena.getEpoch(id).settlementTime) - 1);
        vm.prank(owner);
        vm.expectRevert(IFeeArenaV3.SettleTooEarly.selector);
        arena.submitSettlementPrice(id, P100K, 0, 0, bytes32(0), NO_PRICE_DATA);
    }

    function test_Settle_SanityAnchor_BoundsSubmittedAverage() public {
        id = _openEpoch();
        uint64 st = arena.getEpoch(id).settlementTime;
        vm.warp(st);
        _setPrice(P100K); // the fresh Pyth anchor reads 100,000

        // a submitted "average" 2% away from the anchor exceeds the 1% sanity bound
        vm.prank(owner);
        vm.expectRevert(IFeeArenaV3.SettlePriceOutOfBounds.selector);
        arena.submitSettlementPrice(id, 102_000e18, st - 60, st, bytes32(0), NO_PRICE_DATA);

        // 0.5% away passes — the 60s average may legitimately differ a little from spot
        vm.prank(owner);
        arena.submitSettlementPrice(id, 100_500e18, st - 60, st, keccak256("s"), NO_PRICE_DATA);
        assertEq(arena.getEpoch(id).finalPrice18, 100_500e18);
    }

    function test_Settle_AnchorMustPostdateSettlementTime() public {
        id = _openEpoch();
        uint64 st = arena.getEpoch(id).settlementTime;
        vm.warp(st - 10);
        _setPrice(P100K); // anchor stamped BEFORE the settlement moment
        vm.warp(st + 1);
        vm.prank(owner);
        vm.expectRevert(IFeeArenaV3.SettlePriceTooOld.selector);
        arena.submitSettlementPrice(id, P100K, st - 60, st, bytes32(0), NO_PRICE_DATA);
    }

    function test_Settle_OnlyOwnerOrKeeper() public {
        id = _openEpoch();
        vm.warp(arena.getEpoch(id).settlementTime);
        _setPrice(P100K);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IFeeArenaV3.NotOwnerOrKeeper.selector);
        arena.submitSettlementPrice(id, P100K, 0, 0, bytes32(0), NO_PRICE_DATA);

        // the configured keeper may settle
        vm.prank(owner);
        arena.setKeeper(keeper);
        vm.prank(keeper);
        arena.submitSettlementPrice(id, P100K, 0, 0, bytes32(0), NO_PRICE_DATA);
        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArenaV3.PhaseView.Settling));
    }

    // =====================================================================
    // Batch processing
    // =====================================================================

    function test_Process_Batched_CursorResumes() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.UP, P100K);
        _stakeAt(ayse, IFeeArenaV3.Side.DOWN, P100K);
        _stakeAt(lpC, IFeeArenaV3.Side.RANGE, P100K);
        _settleAt(P100K); // unchanged -> RANGE correct for all anchors here

        arena.processPositions(id, 2);
        (uint32 done, uint32 total) = arena.processProgress(id);
        assertEq(done, 2);
        assertEq(total, 3);

        arena.processPositions(id, 10);
        (done,) = arena.processProgress(id);
        assertEq(done, 3, "cursor resumed to completion");

        // finalize only after full processing
        arena.finalizeEpoch(id);
        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArenaV3.PhaseView.Settled));
    }

    function test_Process_BeforePrice_Reverts() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.UP, P100K);
        vm.expectRevert(IFeeArenaV3.WrongPhase.selector);
        arena.processPositions(id, 10);
    }

    function test_Process_RevertingCollect_IsParked() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.RANGE, P100K);
        _stakeAt(ayse, IFeeArenaV3.Side.RANGE, P100K);
        _programOwed(_tokenIdOf(ali), 0, 100e6);
        _programOwed(_tokenIdOf(ayse), 0, 50e6);
        npm.setCollectReverts(_tokenIdOf(ali), true); // hostile/broken position

        _settleAt(P100K);
        arena.processPositions(id, 10);

        IFeeArenaV3.StakeView memory a = arena.getStake(_tokenIdOf(ali));
        assertTrue(a.processed, "parked but processed");
        assertFalse(a.won, "parked position is not a winner");
        assertEq(a.contributionUsd6, 0);

        IFeeArenaV3.StakeView memory b = arena.getStake(_tokenIdOf(ayse));
        assertTrue(b.won, "neighbor unaffected");
        assertEq(b.contributionUsd6, 50e6);

        arena.finalizeEpoch(id);
        arena.claim(_tokenIdOf(ayse)); // sole eligible winner: own fees (pot is empty)
        assertEq(usdc.balanceOf(ayse), 50e6);
    }

    function test_Finalize_RequiresFullProcessing() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.UP, P100K);
        _stakeAt(ayse, IFeeArenaV3.Side.DOWN, P100K);
        _settleAt(P100K);
        arena.processPositions(id, 1);
        vm.expectRevert(IFeeArenaV3.ProcessNotComplete.selector);
        arena.finalizeEpoch(id);
    }

    // =====================================================================
    // Claim math — winners keep own fees + split the loser pot by USD notional
    // =====================================================================

    function test_Claim_OwnFeesPlusProRataPotShare_UsdNotional() public {
        id = _openEpoch();
        // Two RANGE winners with EQUAL $100 contributions via DIFFERENT tokens:
        //   ali:  $100 in USDC fees
        //   ayse: $100 in cirBTC fees (100,000 raw 8-dp units * $100,000 / 1e20 = $100)
        // One UP loser forfeiting 300e6 USDC + 200,000 raw cirBTC.
        _stakeAt(ali, IFeeArenaV3.Side.RANGE, P100K);
        _stakeAt(ayse, IFeeArenaV3.Side.RANGE, P100K);
        _stakeAt(lpC, IFeeArenaV3.Side.UP, P100K);
        _programOwed(_tokenIdOf(ali), 0, 100e6);
        _programOwed(_tokenIdOf(ayse), 100_000, 0);
        _programOwed(_tokenIdOf(lpC), 200_000, 300e6);

        _settleProcessFinalize(P100K); // unchanged -> RANGE correct; UP loses

        IFeeArenaV3.EpochView memory e = arena.getEpoch(id);
        assertEq(e.potUSDC, 300e6, "loser USDC forfeited");
        assertEq(e.potBase, 200_000, "loser cirBTC forfeited");
        assertEq(e.totalWinnerContribution, 200e6, "two equal $100 contributions");
        assertEq(e.winnerCount, 2);

        // equal contributions -> each winner gets own fees + HALF of each pot token
        arena.claim(_tokenIdOf(ali));
        assertEq(usdc.balanceOf(ali), 100e6 + 150e6, "own USDC fees + half the USDC pot");
        assertEq(base.balanceOf(ali), 100_000, "half the cirBTC pot");

        arena.claim(_tokenIdOf(ayse));
        assertEq(usdc.balanceOf(ayse), 150e6, "half the USDC pot");
        assertEq(base.balanceOf(ayse), 100_000 + 100_000, "own cirBTC fees + half the pot");

        // double claim guarded
        vm.expectRevert(IFeeArenaV3.AlreadyClaimed.selector);
        arena.claim(_tokenIdOf(ali));
    }

    function test_Claim_BeforeSettled_Reverts() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.RANGE, P100K);
        _programOwed(_tokenIdOf(ali), 0, 10e6);
        _settleAt(P100K);
        arena.processPositions(id, 10); // priced + processed but NOT finalized
        vm.expectRevert(IFeeArenaV3.NotSettled.selector);
        arena.claim(_tokenIdOf(ali));
    }

    function test_Claim_PaysOwner_RegardlessOfCaller() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.RANGE, P100K);
        _programOwed(_tokenIdOf(ali), 0, 10e6);
        _settleProcessFinalize(P100K);
        vm.prank(makeAddr("stranger"));
        arena.claim(_tokenIdOf(ali));
        assertEq(usdc.balanceOf(ali), 10e6, "owner paid, not the caller");
    }

    function test_PreviewClaim_MirrorsClaim() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.RANGE, P100K);
        _stakeAt(ayse, IFeeArenaV3.Side.UP, P100K);
        _programOwed(_tokenIdOf(ali), 0, 40e6);
        _programOwed(_tokenIdOf(ayse), 0, 25e6);
        _settleProcessFinalize(P100K);

        IFeeArenaV3.ClaimPreview memory pv = arena.previewClaim(_tokenIdOf(ali));
        assertTrue(pv.claimable);
        assertTrue(pv.isWinner);
        assertEq(pv.ownFeeUSDC, 40e6);
        assertEq(pv.potShareUSDC, 25e6, "sole winner takes the whole pot");

        uint256 before = usdc.balanceOf(ali);
        arena.claim(_tokenIdOf(ali));
        assertEq(usdc.balanceOf(ali) - before, pv.ownFeeUSDC + pv.potShareUSDC, "preview == actual");

        IFeeArenaV3.ClaimPreview memory lost = arena.previewClaim(_tokenIdOf(ayse));
        assertFalse(lost.claimable);
        assertFalse(lost.isWinner);
    }

    // =====================================================================
    // Empty-winner rollover (never to the house)
    // =====================================================================

    function test_EmptyWinner_PotRollsToNextEpoch() public {
        id = _openEpoch();
        // sole staker calls UP at an unchanged price -> loses; NO winner produced fees
        _stakeAt(ali, IFeeArenaV3.Side.UP, P100K);
        _programOwed(_tokenIdOf(ali), 0, 80e6);
        _settleProcessFinalize(P100K);

        IFeeArenaV3.EpochView memory e1 = arena.getEpoch(id);
        assertTrue(e1.rolledOver);
        assertEq(arena.rolloverUSDC(), 80e6, "pot rolled into the global rollover");

        vm.expectRevert(IFeeArenaV3.NothingToClaim.selector);
        arena.claim(_tokenIdOf(ali));

        // next epoch: the rollover injects into ITS pot at finalize and a winner takes it
        uint64 id2 = _openEpoch();
        _stakeAt(ayse, IFeeArenaV3.Side.RANGE, P100K);
        _programOwed(_tokenIdOf(ayse), 0, 5e6);
        _stakeAt(lpC, IFeeArenaV3.Side.DOWN, P100K);
        _programOwed(_tokenIdOf(lpC), 0, 10e6);
        _settleProcessFinalize(P100K); // RANGE correct: ayse wins, lpC forfeits

        IFeeArenaV3.EpochView memory e2 = arena.getEpoch(id2);
        assertEq(e2.potUSDC, 10e6 + 80e6, "pot = forfeits + injected rollover");
        assertEq(arena.rolloverUSDC(), 0, "rollover consumed");

        arena.claim(_tokenIdOf(ayse));
        assertEq(usdc.balanceOf(ayse), 5e6 + 90e6, "own fees + (forfeits + rollover)");
    }

    // =====================================================================
    // Auto-return + manual unstake + pause posture
    // =====================================================================

    function test_AutoReturn_UnstakeBatch_PushesAllHome() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.UP, P100K);
        _stakeAt(ayse, IFeeArenaV3.Side.DOWN, P100K);
        _settleProcessFinalize(P100K);

        vm.prank(makeAddr("stranger")); // permissionless
        arena.unstakeBatch(id, 10);
        assertEq(npm.ownerOf(_tokenIdOf(ali)), ali);
        assertEq(npm.ownerOf(_tokenIdOf(ayse)), ayse);
        assertEq(arena.unstakeCursor(id), 2);
    }

    function test_AutoReturn_ParksRejectingReceiver_RestReturned() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.RANGE, P100K);

        RejectingStakerV3 rcv = new RejectingStakerV3(arena); // accept == false
        _setPrice(P100K);
        uint256 rcvToken = npm.mintTo(address(rcv), address(base), address(usdc), FEE_TIER, MIN_LIQ);
        vm.roll(block.number + 1);
        rcv.stake(rcvToken, IFeeArenaV3.Side.RANGE, P100K);

        _settleProcessFinalize(P100K);
        arena.unstakeBatch(id, 10);

        assertEq(npm.ownerOf(_tokenIdOf(ali)), ali, "EOA returned");
        assertEq(npm.ownerOf(rcvToken), address(arena), "rejector parked, still escrowed");
        assertFalse(arena.getStake(rcvToken).unstaked, "parked stays owner-pullable");

        rcv.setAccept(true);
        rcv.pull(rcvToken); // manual fallback
        assertEq(npm.ownerOf(rcvToken), address(rcv));
    }

    function test_Pause_BlocksCranks_ManualUnstakeStaysOpen() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.RANGE, P100K);
        _settleProcessFinalize(P100K);

        vm.prank(owner);
        arena.pause();

        vm.expectRevert(bytes("Pausable: paused"));
        arena.unstakeBatch(id, 10);

        vm.prank(ali); // the user escape hatch survives the pause
        arena.unstake(_tokenIdOf(ali));
        assertEq(npm.ownerOf(_tokenIdOf(ali)), ali);
    }

    function test_Stake_WhenPaused_Reverts() public {
        id = _openEpoch();
        _setPrice(P100K);
        uint256 t = npm.mintTo(ali, address(base), address(usdc), FEE_TIER, MIN_LIQ);
        vm.roll(block.number + 1);
        vm.prank(owner);
        arena.pause();
        vm.prank(ali);
        vm.expectRevert(bytes("Pausable: paused"));
        arena.stakeWithSide(t, IFeeArenaV3.Side.UP, P100K, 50, NO_PRICE_DATA);
    }

    // =====================================================================
    // Emergency escape hatch
    // =====================================================================

    function test_EmergencySettle_UnlocksAfterGrace() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.UP, P100K);
        uint64 st = arena.getEpoch(id).settlementTime;

        vm.warp(uint256(st) + arena.GRACE());
        vm.prank(owner);
        vm.expectRevert(IFeeArenaV3.GraceNotElapsed.selector);
        arena.emergencySettle(id);

        vm.warp(uint256(st) + arena.GRACE() + 1);
        vm.prank(owner);
        arena.emergencySettle(id);

        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArenaV3.PhaseView.Settled));
        vm.prank(ali);
        arena.unstake(_tokenIdOf(ali)); // positions are recoverable
        assertEq(npm.ownerOf(_tokenIdOf(ali)), ali);
        vm.expectRevert(IFeeArenaV3.NothingToClaim.selector);
        arena.claim(_tokenIdOf(ali)); // nothing was resolved -> nothing claimable

        // the lifecycle continues: a new epoch can be created
        uint64 id2 = _openEpoch();
        assertEq(id2, id + 1);
    }

    // =====================================================================
    // Lifecycle + views
    // =====================================================================

    function test_PhaseView_Derivation() public {
        id = _openEpoch();
        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArenaV3.PhaseView.EntryOpen));

        vm.warp(arena.getEpoch(id).entryCloseTime); // entry over, watching
        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArenaV3.PhaseView.Locked));

        _settleAt(P100K);
        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArenaV3.PhaseView.Settling));

        arena.processPositions(id, 10);
        arena.finalizeEpoch(id);
        assertEq(uint8(arena.getEpoch(id).phase), uint8(IFeeArenaV3.PhaseView.Settled));
    }

    function test_CreateEpoch_SequentialGate() public {
        id = _openEpoch();
        vm.prank(owner);
        vm.expectRevert(IFeeArenaV3.PrevNotSettled.selector);
        arena.createEpoch();
    }

    function test_GetUserStakes_SpansEpochs() public {
        id = _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.RANGE, P100K);
        _settleProcessFinalize(P100K);
        _openEpoch();
        _stakeAt(ali, IFeeArenaV3.Side.UP, 101_000e18);

        IFeeArenaV3.StakeView[] memory mine = arena.getUserStakes(ali);
        assertEq(mine.length, 2);
        assertEq(mine[0].entryPrice18, P100K);
        assertEq(mine[1].entryPrice18, 101_000e18);
    }
}
