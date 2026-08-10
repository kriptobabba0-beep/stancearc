// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @notice Guards the storage offsets used by `_epochRaw` (claimedWETH/USDC + rolloverConsumed)
///         against the packed `struct Epoch` layout. If FeeArena's layout shifts, these break
///         loudly here instead of silently corrupting the invariant suites' accounting reads.
contract EpochRawSlotsTest is FeeArenaTestBase {
    function setUp() public override {
        _deployArenaSystem();
    }

    function test_EpochRaw_ClaimedAndRolloverConsumed() public {
        // --- Epoch 1: normal winner, one UP staker who claims the full pot ---
        address lp = makeAddr("lpA");
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        uint256 wethFee = 3e18;
        uint256 usdcFee = 1000e6;
        _stakeOwed(lp, IFeeArena.Side.UP, wethFee, usdcFee);
        _warpToEntryClose();
        _setOraclePrice(DEFAULT_START_PRICE);
        arena.startEpoch(new bytes[](0));
        _endEpochAtPrice(3300e18); // +10% -> UP wins
        arena.sweep(10);

        // before finalize: rolloverConsumed must be false
        (uint256 cw0, uint256 cu0, bool rc0) = _epochRaw(1);
        assertEq(cw0, 0, "claimedWETH should start at 0");
        assertEq(cu0, 0, "claimedUSDC should start at 0");
        assertFalse(rc0, "rolloverConsumed should be false pre-finalize");

        arena.finalizeSettle();
        (,, bool rc1) = _epochRaw(1);
        assertTrue(rc1, "rolloverConsumed must be true post-finalize");

        // claim the full pot (single winner) and verify claimed counters
        IFeeArena.ClaimPreview memory pv = arena.previewClaim(1, _tokenIdOf(lp));
        vm.prank(lp);
        arena.claim(1, _tokenIdOf(lp));
        (uint256 cw1, uint256 cu1,) = _epochRaw(1);
        assertEq(cw1, pv.payWETH, "claimedWETH offset wrong");
        assertEq(cu1, pv.payUSDC, "claimedUSDC offset wrong");
        assertEq(cw1, wethFee, "single winner should claim full WETH pot");
        assertEq(cu1, usdcFee, "single winner should claim full USDC pot");

        // --- Epoch 2: empty winner -> rolledOver + rolloverConsumed ---
        vm.prank(owner);
        arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        address d = makeAddr("lpDown");
        _stakeOwed(d, IFeeArena.Side.DOWN, 2e18, 500e6);
        _warpToEntryClose();
        _setOraclePrice(DEFAULT_START_PRICE);
        arena.startEpoch(new bytes[](0));
        _endEpochAtPrice(3300e18); // UP wins, no UP stakers -> empty winner
        arena.sweep(10);
        arena.finalizeSettle();
        (,, bool rc2) = _epochRaw(2);
        assertTrue(rc2, "empty-winner epoch must have rolloverConsumed=true");
        assertTrue(arena.getEpoch(2).rolledOver, "epoch 2 should be rolled over");
    }
}
