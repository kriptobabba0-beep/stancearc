// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

// Compile-only aggregator for the unmodified =0.7.6 Uniswap V3 fork.
//
// forge only compiles files reachable from src/test/script imports. The fork
// tests deploy the V3 contracts via vm.getCode / deployCode by ARTIFACT NAME
// (e.g. "UniswapV3Pool.sol:UniswapV3Pool"), which requires the artifact to
// already exist in out/. Importing the four V3 entrypoints here makes forge
// compile them (and the whole 0.7.6 dependency graph) under their own solc, so
// the 0.8.20 fork tests can load the bytecode. This file is NEVER imported by
// any 0.8.x source — it only exists to populate out/.
import {UniswapV3Pool} from "@uniswap/v3-core/contracts/UniswapV3Pool.sol";
import {UniswapV3Factory} from "@uniswap/v3-core/contracts/UniswapV3Factory.sol";
import {NonfungiblePositionManager} from "@uniswap/v3-periphery/contracts/NonfungiblePositionManager.sol";
import {SwapRouter} from "@uniswap/v3-periphery/contracts/SwapRouter.sol";
// QuoterV2 gives the swap form an EXACT quote: it walks the ticks the way the pool will, so a trade
// that crosses into thinner liquidity is priced correctly instead of optimistically.
import {QuoterV2} from "@uniswap/v3-periphery/contracts/lens/QuoterV2.sol";
