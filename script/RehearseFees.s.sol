// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";

/// @notice One-broadcast PROOF that real swaps now generate real fees on the cirBTC/USDC pool
///         (they were always 0 on the mock pool). Seeds a full-range LP with the deployer's real
///         cirBTC + USDC, runs a real swap through the SwapRouter, then collects the accrued fees.
///         Helpers keep each frame stack-shallow (project compiles with via_ir OFF).
contract RehearseFees is Script {
    struct Env {
        address me;
        address base; // cirBTC (8dp)
        address usdc; // 0x3600... (6dp)
        address npm;
        address pool;
        address router;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Env memory e = Env({
            me: vm.addr(pk),
            base: vm.envAddress("BASE_TOKEN"),
            usdc: vm.envAddress("USDC_ADDR"),
            npm: vm.envAddress("NPM_ADDR"),
            pool: vm.envAddress("POOL_ADDR"),
            router: vm.envAddress("ROUTER_ADDR")
        });

        vm.startBroadcast(pk);
        uint256 tokenId = _mint(e);
        _swap(e, vm.envOr("SWAP_IN_USDC", uint256(2e5)));
        (uint256 c0, uint256 c1) = _collect(e, tokenId);
        vm.stopBroadcast();

        console2.log("=== FEES COLLECTED (raw) token0 / token1 ===");
        console2.log(c0);
        console2.log(c1);
        console2.log("=== POOL feeGrowthGlobal 0 / 1 (was 0 on the mock pool) ===");
        console2.log(IPool(e.pool).feeGrowthGlobal0X128());
        console2.log(IPool(e.pool).feeGrowthGlobal1X128());
    }

    function _mint(Env memory e) internal returns (uint256 tokenId) {
        IERC20(e.base).approve(e.npm, type(uint256).max);
        IERC20(e.usdc).approve(e.npm, type(uint256).max);
        int24 spacing = IPool(e.pool).tickSpacing();
        address t0 = IPool(e.pool).token0();
        bool baseIs0 = (t0 == e.base);
        uint256 baseAmt = IERC20(e.base).balanceOf(e.me);
        uint256 usdcForLp = vm.envOr("USDC_FOR_LP", uint256(6e6));
        tokenId = _doMint(e, spacing, baseIs0, baseAmt, usdcForLp);
        console2.log("LP tokenId:", tokenId);
    }

    function _doMint(Env memory e, int24 spacing, bool baseIs0, uint256 baseAmt, uint256 usdcForLp)
        internal
        returns (uint256 tokenId)
    {
        (uint256 tid,,,) = INonfungiblePositionManager(e.npm)
            .mint(
                INonfungiblePositionManager.MintParams({
                token0: baseIs0 ? e.base : e.usdc,
                token1: baseIs0 ? e.usdc : e.base,
                fee: 3000,
                tickLower: (int24(-887272) / spacing) * spacing,
                tickUpper: (int24(887272) / spacing) * spacing,
                amount0Desired: baseIs0 ? baseAmt : usdcForLp,
                amount1Desired: baseIs0 ? usdcForLp : baseAmt,
                amount0Min: 0,
                amount1Min: 0,
                recipient: e.me,
                deadline: block.timestamp + 3600
            })
            );
        tokenId = tid;
    }

    function _swap(Env memory e, uint256 swapIn) internal returns (uint256 out) {
        IERC20(e.usdc).approve(e.router, type(uint256).max);
        out = IRouter(e.router)
            .exactInputSingle(
                IRouter.ExactInputSingleParams({
                tokenIn: e.usdc,
                tokenOut: e.base,
                fee: 3000,
                recipient: e.me,
                deadline: block.timestamp + 3600,
                amountIn: swapIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
            );
        console2.log("swapped USDC raw(6dp):", swapIn);
        console2.log("received cirBTC raw(8dp):", out);
    }

    function _collect(Env memory e, uint256 tokenId) internal returns (uint256 c0, uint256 c1) {
        (c0, c1) = INonfungiblePositionManager(e.npm)
            .collect(
                INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: e.me, amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
            );
    }
}

interface IPool {
    function tickSpacing() external view returns (int24);
    function token0() external view returns (address);
    function feeGrowthGlobal0X128() external view returns (uint256);
    function feeGrowthGlobal1X128() external view returns (uint256);
}

interface IRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
