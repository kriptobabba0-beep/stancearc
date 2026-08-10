// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {FeeArenaHandler} from "test/invariant/handlers/FeeArenaHandler.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";

/// @notice Conservation: nothing is created or destroyed. Every WETH/USDC made collectable on a
///         staked position and funded into the vault is either still HELD by the vault or was
///         DISTRIBUTED to a winner — never minted, leaked, or double-paid. Also folds in the
///         per-epoch pot-ceiling property (claimed <= pot) and the empty->empty->normal chain.
///
/// @dev The handler's MockNPM.collect() does not move real tokens, so the handler funds the vault
///      with each seeded fee (mirror of FeeArenaTestBase._programOwed). The ONLY token outflow
///      from the vault is a claim payout (rollover/foldDust move accounting, not tokens; unstake
///      returns the NFT, not ERC20). So at ALL times:
///          balanceOf(asset) + Sigma(distributed) == Sigma(funded fees)
///      which is the exact conservation statement asserted below.
contract ConservationInvariant is FeeArenaTestBase {
    FeeArenaHandler internal handler;

    function setUp() public override {
        _deployArenaSystem();
        handler = new FeeArenaHandler(
            arena, oracle, npm, address(weth), address(usdc), address(pool), FEE_TIER, MIN_LIQUIDITY, owner
        );
        vm.prank(owner);
        arena.transferOwnership(address(handler));
        oracle.transferOwnership(address(handler));

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

    /// fees-funded == (still held in vault) + (distributed). Nothing created or destroyed.
    function invariant_Conservation() public view {
        // Strong token conservation on both legs.
        assertEq(
            IERC20(address(weth)).balanceOf(address(arena)) + handler.ghost_paidWETH(),
            handler.ghost_feesSeededWETH(),
            "WETH not conserved"
        );
        assertEq(
            IERC20(address(usdc)).balanceOf(address(arena)) + handler.ghost_paidUSDC(),
            handler.ghost_feesSeededUSDC(),
            "USDC not conserved"
        );

        // Swept fees can never exceed seeded fees (collect realizes a subset of what was seeded).
        assertLe(handler.ghost_feesSeededWETHSwept(), handler.ghost_feesSeededWETH(), "swept > seeded WETH");
        assertLe(handler.ghost_feesSeededUSDCSwept(), handler.ghost_feesSeededUSDC(), "swept > seeded USDC");

        // Per-epoch pot-ceiling property: a winning side is never paid more than its pot (floor
        // accounting), on either leg. A folded epoch mirrors claimed == pot (residual rolled out).
        uint64 last = arena.currentEpochId();
        for (uint64 id = 1; id <= last; ++id) {
            IFeeArena.EpochView memory e = arena.getEpoch(id);
            assertLe(handler.ghost_epochClaimedWETH(id), e.potWETH, "epoch overpaid WETH");
            assertLe(handler.ghost_epochClaimedUSDC(id), e.potUSDC, "epoch overpaid USDC");
        }
    }
}
