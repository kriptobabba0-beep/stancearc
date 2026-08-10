// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {IUniswapV3Factory} from "src/interfaces/IUniswapV3Factory.sol";
import {INonfungiblePositionManager} from "src/interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter} from "src/interfaces/ISwapRouter.sol";

/// @notice Deploys the unmodified =0.7.6 Uniswap V3 fork (factory + NPM + router)
///         from compiled creationCode and returns 0.8.x LOCAL interface handles.
///         Never imports 0.7.6 Solidity into this 0.8.x file (deploys by bytecode
///         only via vm.getCode + assembly create). The artifacts are produced by
///         test/fork/imports/V3Artifacts.sol (compile-only aggregator).
library V3Deployer {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct V3 {
        IUniswapV3Factory factory;
        INonfungiblePositionManager npm;
        ISwapRouter router;
    }

    int24 internal constant TICK_SPACING_3000 = 60;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    /// @param weth address of the WETH9 token used by NPM/router constructors
    /// @dev tokenDescriptor is passed as address(0) (NPM tolerates it for tests/no tokenURI).
    function deploy(address weth) internal returns (V3 memory v3) {
        // 1) Factory: constructor() — no args.
        address factory = _create(vm.getCode("UniswapV3Factory.sol:UniswapV3Factory"));
        require(factory != address(0), "factory deploy failed");

        // 2) NonfungiblePositionManager(address factory, address weth9, address tokenDescriptor)
        bytes memory npmCode = abi.encodePacked(
            vm.getCode("NonfungiblePositionManager.sol:NonfungiblePositionManager"),
            abi.encode(factory, weth, address(0))
        );
        address npm = _create(npmCode);
        require(npm != address(0), "npm deploy failed");

        // 3) SwapRouter(address factory, address weth9)
        bytes memory routerCode = abi.encodePacked(vm.getCode("SwapRouter.sol:SwapRouter"), abi.encode(factory, weth));
        address router = _create(routerCode);
        require(router != address(0), "router deploy failed");

        v3 = V3({
            factory: IUniswapV3Factory(factory), npm: INonfungiblePositionManager(npm), router: ISwapRouter(router)
        });
    }

    function _create(bytes memory bytecode) private returns (address addr) {
        require(bytecode.length > 0, "missing artifact: run forge build");
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
    }

    /// @notice Create+initialize the WETH/USDC pool at fee tier `fee`.
    /// @param sqrtPriceX96 initial sqrt price (token1/token0) for the SORTED pair.
    function createAndInitPool(V3 memory v3, address tokenA, address tokenB, uint24 fee, uint160 sqrtPriceX96)
        internal
        returns (address pool)
    {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pool = v3.factory.createPool(t0, t1, fee);
        require(pool != address(0), "createPool failed");
        IUniswapV3PoolInit(pool).initialize(sqrtPriceX96);
    }

    /// @notice Mint a full-range position to `recipient`. Caller must have approved
    ///         the NPM for `amountADesired`/`amountBDesired` on BOTH tokens beforehand.
    ///         Params built in a helper to keep this frame within the legacy-pipeline
    ///         stack limit (via_ir is off in the mixed-solc workspace).
    function mintPosition(
        V3 memory v3,
        address tokenA,
        address tokenB,
        uint24 fee,
        address recipient,
        uint256 amountADesired,
        uint256 amountBDesired
    ) internal returns (uint256 tokenId, uint128 liquidity) {
        (tokenId, liquidity,,) = v3.npm
            .mint(_buildMintParams(tokenA, tokenB, fee, recipient, amountADesired, amountBDesired));
        require(liquidity > 0, "mint produced zero liquidity");
    }

    function _buildMintParams(
        address tokenA,
        address tokenB,
        uint24 fee,
        address recipient,
        uint256 amountADesired,
        uint256 amountBDesired
    ) private view returns (INonfungiblePositionManager.MintParams memory p) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        (uint256 a0, uint256 a1) = tokenA < tokenB ? (amountADesired, amountBDesired) : (amountBDesired, amountADesired);

        int24 spacing = TICK_SPACING_3000; // V0 tests fix fee tier 3000 -> spacing 60
        p = INonfungiblePositionManager.MintParams({
            token0: t0,
            token1: t1,
            fee: fee,
            tickLower: (MIN_TICK / spacing) * spacing,
            tickUpper: (MAX_TICK / spacing) * spacing,
            amount0Desired: a0,
            amount1Desired: a1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: recipient,
            deadline: block.timestamp + 1
        });
    }

    /// @notice Exact-input single swap; caller must have approved the router for `amountIn`.
    function swapExactInput(
        V3 memory v3,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        ISwapRouter.ExactInputSingleParams memory p = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: recipient,
            deadline: block.timestamp + 1,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });
        amountOut = v3.router.exactInputSingle(p);
    }
}

/// @notice Minimal pool-init surface (the 0.7.6 pool's initialize), declared locally
///         so the deployer never imports the >=0.5.0 Uniswap composite interface.
interface IUniswapV3PoolInit {
    function initialize(uint160 sqrtPriceX96) external;
}
