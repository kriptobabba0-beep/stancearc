// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {FeeArenaHandler} from "test/invariant/handlers/FeeArenaHandler.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @notice TOP-PRIORITY invariant (spec §7.2): the vault is never insolvent on either leg —
///         balanceOf(asset) >= Σ unclaimed pot over open settled epochs + global rollover.
contract SolvencyInvariant is FeeArenaTestBase {
    FeeArenaHandler internal handler;

    function setUp() public override {
        _deployArenaSystem(); // base fixture: tokens, oracle, MockNPM, FeeArena; demo timings/band
        handler = new FeeArenaHandler(
            arena, oracle, npm, address(weth), address(usdc), address(pool), FEE_TIER, MIN_LIQUIDITY, owner
        );
        // The handler is the owner-acting party too (createEpoch/openEntry are owner; cranks are
        // permissionless). It also needs to set oracle prices, so hand it the oracle ownership.
        vm.prank(owner);
        arena.transferOwnership(address(handler));
        oracle.transferOwnership(address(handler));

        // Restrict fuzzing to the handler's external action selectors.
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = handler.actStakeAndAdvance.selector;
        sel[1] = handler.actSeedFees.selector;
        sel[2] = handler.actEndAndResolve.selector;
        sel[3] = handler.actSweep.selector;
        sel[4] = handler.actFinalize.selector;
        sel[5] = handler.actClaim.selector;
        sel[6] = handler.actFoldDust.selector;
        sel[7] = handler.actUnstake.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// TOP PRIORITY (spec §7.2): vault never insolvent on either leg.
    function invariant_Solvency() public view {
        uint256 needWETH = arena.rolloverWETH();
        uint256 needUSDC = arena.rolloverUSDC();
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            IFeeArena.EpochView memory e = arena.getEpoch(id);
            // Unclaimed pot still owed to winners over settled, non-rolled epochs. A folded epoch
            // has its residual moved to the global rollover, so its mirror == pot (need == 0).
            if (e.phase == IFeeArena.PhaseView.Settled && !e.rolledOver) {
                needWETH += e.potWETH - handler.ghost_epochClaimedWETH(id);
                needUSDC += e.potUSDC - handler.ghost_epochClaimedUSDC(id);
            }
        }
        assertGe(IERC20(address(weth)).balanceOf(address(arena)), needWETH, "WETH insolvent");
        assertGe(IERC20(address(usdc)).balanceOf(address(arena)), needUSDC, "USDC insolvent");
    }
}
