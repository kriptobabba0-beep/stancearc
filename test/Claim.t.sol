// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Task M5 — pull-based mixed claim; reproduces the spec §4.5 worked example's
///         split shape with the NEW metric: `contribution6` is RANGE-NORMALIZED STAKED
///         LIQUIDITY (`liquidity * tickSpan`) of an in-range (fee-realizing) position, NOT
///         the fee USDC-notional. All positions share the uniform DEFAULT_TICK_SPAN, so the
///         span CANCELS in the 5/8 vs 3/8 ratio: staking LP-A with 5000 liquidity and LP-B
///         with 3000 (UP denom (8000)*span) still gives UP wins, pot 4 WETH + 6000 USDC;
///         LP-A 5/8 -> 2.5 WETH + $3750, LP-B 3/8 -> 1.5 WETH + $2250. The fee amounts no
///         longer drive the split (wash-resistance): they only fund the pot.
contract ClaimTest is FeeArenaTestBase {
    address lpA = makeAddr("A"); // UP    liquidity 5000 -> contribution 5000
    address lpB = makeAddr("B"); // UP    liquidity 3000 -> contribution 3000
    address lpC = makeAddr("C"); // DOWN  loser
    address lpD = makeAddr("D"); // RANGE loser
    uint64 id;

    /// @dev mint with explicit liquidity, stake on `side`, program the owed fees.
    function _stakeLiqOwed(address lp, IFeeArena.Side side, uint128 liquidity, uint256 owedWeth, uint256 owedUsdc)
        internal
        returns (uint256 tokenId)
    {
        tokenId = _mintPosition(lp, liquidity);
        vm.roll(block.number + 1); // one-action-per-block guard across stakers
        vm.prank(lp);
        npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(side));
        tokenIdByOwner[lp] = tokenId;
        _programOwed(tokenId, owedWeth, owedUsdc);
    }

    function _setupWorkedExample() internal {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        // UP winners with UNEQUAL staked liquidity (5000 / 3000) drive the 5/8 vs 3/8 split.
        // Fee amounts are arbitrary here (they only fund the pot, not the split).
        _stakeLiqOwed(lpA, IFeeArena.Side.UP, 5000, 1e18, 2000e6);
        _stakeLiqOwed(lpB, IFeeArena.Side.UP, 3000, 1e18, 0);
        _stakeLiqOwed(lpC, IFeeArena.Side.DOWN, 6000, 1e18, 3000e6);
        _stakeLiqOwed(lpD, IFeeArena.Side.RANGE, 4000, 1e18, 1000e6);
        _startCurrentAt(2000e18); // low start so 3000 settle is a clean UP win
        _endEpochAtPrice(3000e18);
        arena.sweep(10); // Swept; pot = 4 WETH + 6000 USDC
        arena.finalizeSettle(); // Settled; denom = UP liquidity total = 8000
    }

    function test_WorkedExample_LpA_LpB_Payouts() public {
        _setupWorkedExample();
        IFeeArena.EpochView memory e = arena.getEpoch(id);
        uint256 span = uint256(DEFAULT_TICK_SPAN); // uniform span cancels in the 5/8 vs 3/8 ratios
        assertEq(e.winnerDenominator, 8000 * span, "UP denominator = (staked liquidity total) * span");
        assertEq(e.potWETH, 4e18, "4 WETH pot");
        assertEq(e.potUSDC, 6000e6, "6000 USDC pot");
        assertEq(e.sideContribution6[uint8(IFeeArena.Side.UP)], 8000 * span);
        assertEq(e.sideContribution6[uint8(IFeeArena.Side.DOWN)], 6000 * span);
        assertEq(e.sideContribution6[uint8(IFeeArena.Side.RANGE)], 4000 * span);

        arena.claim(id, _tokenIdOf(lpA));
        assertEq(IERC20(address(weth)).balanceOf(lpA), 2.5e18, "LP-A 2.5 WETH");
        assertEq(IERC20(address(usdc)).balanceOf(lpA), 3750e6, "LP-A $3750");

        arena.claim(id, _tokenIdOf(lpB));
        assertEq(IERC20(address(weth)).balanceOf(lpB), 1.5e18, "LP-B 1.5 WETH");
        assertEq(IERC20(address(usdc)).balanceOf(lpB), 2250e6, "LP-B $2250");

        // conservation: claimed == pot exactly (no dust in this example)
        IFeeArena.EpochView memory e2 = arena.getEpoch(id);
        assertEq(IERC20(address(weth)).balanceOf(lpA) + IERC20(address(weth)).balanceOf(lpB), e2.potWETH);
        assertEq(IERC20(address(usdc)).balanceOf(lpA) + IERC20(address(usdc)).balanceOf(lpB), e2.potUSDC);
    }

    function test_Loser_Claim_RevertsWrongSide() public {
        _setupWorkedExample();
        vm.expectRevert(IFeeArena.WrongSide.selector);
        arena.claim(id, _tokenIdOf(lpC)); // DOWN
    }

    function test_Claim_PaysOwner_RegardlessOfCaller() public {
        _setupWorkedExample();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        arena.claim(id, _tokenIdOf(lpA)); // stranger calls, owner gets paid
        assertEq(IERC20(address(weth)).balanceOf(lpA), 2.5e18);
        assertEq(IERC20(address(weth)).balanceOf(stranger), 0);
    }

    function test_DoubleClaim_Reverts() public {
        _setupWorkedExample();
        arena.claim(id, _tokenIdOf(lpA));
        vm.expectRevert(IFeeArena.AlreadyClaimed.selector);
        arena.claim(id, _tokenIdOf(lpA));
    }

    function test_Claim_BeforeSettled_Reverts() public {
        vm.prank(owner);
        id = arena.createEpoch();
        vm.prank(owner);
        arena.openEntry();
        _stakeOwed(lpA, IFeeArena.Side.UP, 1e18, 2000e6);
        _startCurrentAt(2000e18);
        _endEpochAtPrice(3000e18); // Resolved only
        vm.expectRevert(IFeeArena.NotSettled.selector);
        arena.claim(id, _tokenIdOf(lpA));
    }

    // ---- Task M10: previewClaim ----

    function test_PreviewClaim_FloorProjection_MatchesActual() public {
        _setupWorkedExample();
        IFeeArena.ClaimPreview memory pv = arena.previewClaim(id, _tokenIdOf(lpA));
        assertTrue(pv.claimable);
        assertTrue(pv.isWinner);
        assertFalse(pv.alreadyClaimed);
        assertEq(pv.payWETH, 2.5e18);
        assertEq(pv.payUSDC, 3750e6);
        assertEq(pv.contribution6, uint256(5000) * uint256(DEFAULT_TICK_SPAN)); // LP-A liquidity * span
        assertEq(pv.winnerDenominator, uint256(8000) * uint256(DEFAULT_TICK_SPAN)); // UP (liquidity total) * span

        arena.claim(id, _tokenIdOf(lpA));
        IFeeArena.ClaimPreview memory pv2 = arena.previewClaim(id, _tokenIdOf(lpA));
        assertTrue(pv2.alreadyClaimed);
        assertFalse(pv2.claimable);
    }

    function test_PreviewClaim_Loser_NotClaimable() public {
        _setupWorkedExample();
        IFeeArena.ClaimPreview memory pv = arena.previewClaim(id, _tokenIdOf(lpC)); // DOWN
        assertFalse(pv.isWinner);
        assertFalse(pv.claimable);
        assertEq(pv.payWETH, 0);
        assertEq(pv.payUSDC, 0);
    }
}
