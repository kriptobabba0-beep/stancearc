// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FeeArena} from "src/FeeArena.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";

/// @notice Task M1 — regression checks confirming L1's boot-derived WETH_NOTIONAL_DIV
///         (== 1e30 for 18/18/6) and the constructor's decimals hard-asserts. The
///         constant + immutable + derivation already exist in L1, so these are
///         GREEN regression locks (not red-first).
contract ContributionBootTest is FeeArenaTestBase {
    function test_WethNotionalDiv_IsTenPow30_For_18_18_6() public view {
        // base fixture deploys USDC(6dp) + WETH(18dp); PRICE_DECIMALS == 18
        assertEq(arena.WETH_NOTIONAL_DIV(), 1e30, "10**(18+18-6) == 1e30");
    }

    function test_Constructor_Reverts_When_USDC_NotSix() public {
        TestERC20 badUsdc = new TestERC20("BadUSDC", "BUSDC", 8); // wrong decimals
        vm.expectRevert(IFeeArena.BadDecimals.selector);
        _deployArenaWithUsdc(address(badUsdc));
    }

    function test_Constructor_Succeeds_When_NonUSdc_IsNonEighteen() public {
        // Post-anti-manipulation the 18-dp constraint on the non-USDC leg is vestigial —
        // WETH_NOTIONAL_DIV is dead as a winner metric. Any non-USDC decimals must bind.
        // Use 8-dp (WBTC) as the representative non-18 case.
        TestERC20 wbtcLike = new TestERC20("Wrapped BTC", "WBTC", 8);
        FeeArena arena8 = _deployArenaWithWeth(address(wbtcLike));
        assertEq(arena8.WETH(), address(wbtcLike), "8-dp base leg bound");
        // WETH_NOTIONAL_DIV = 10**(8+18-6) = 10**20 (derived, not hardcoded)
        assertEq(arena8.WETH_NOTIONAL_DIV(), 10 ** 20, "notionalDiv for 8-dp base");
    }
}

/// @notice Task M3 — collect token-ordering correctness through sweep. Whether the
///         pool reports WETH as token0 or token1, the WETH/USDC fee split must be
///         identical. `contribution6` is now RANGE-NORMALIZED STAKED LIQUIDITY
///         (`liquidity * tickSpan`, gated on realizing any fee = in-range proxy), NOT the
///         fee USDC-notional, so it equals MIN_LIQUIDITY * DEFAULT_TICK_SPAN regardless of
///         how the fees split by token.
contract ContributionOrderingTest is FeeArenaTestBase {
    address lp = makeAddr("lpOrd");

    function _runSingleSweepGetStake() internal returns (IFeeArena.StakeView memory) {
        _openRunningEpochWith(lp, IFeeArena.Side.UP, 1e18, 2000e6);
        _endEpochAtPrice(3000e18);
        arena.sweep(10);
        return arena.getStake(_tokenIdOf(lp));
    }

    function test_Contribution_WethIsToken0() public {
        _setPoolTokenOrder(true); // pool.token0() == WETH; arena re-resolved
        assertEq(uint256(arena.wethIsToken0()), 1, "wethIsToken0 == 1");
        IFeeArena.StakeView memory s = _runSingleSweepGetStake();
        assertEq(s.feeWETH, 1e18);
        assertEq(s.feeUSDC, 2000e6);
        // contribution6 == liquidity * tickSpan (any fee realized => in-range), token-order-independent
        assertEq(s.contribution6, uint256(MIN_LIQUIDITY) * uint256(DEFAULT_TICK_SPAN));
    }

    function test_Contribution_WethIsToken1() public {
        _setPoolTokenOrder(false); // pool.token0() == USDC -> WETH is token1
        assertEq(uint256(arena.wethIsToken0()), 0, "wethIsToken0 == 0");
        IFeeArena.StakeView memory s = _runSingleSweepGetStake();
        assertEq(s.feeWETH, 1e18);
        assertEq(s.feeUSDC, 2000e6);
        assertEq(s.contribution6, uint256(MIN_LIQUIDITY) * uint256(DEFAULT_TICK_SPAN));
    }
}
