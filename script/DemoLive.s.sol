// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeArena} from "../src/FeeArena.sol";
import {IFeeArena} from "../src/interfaces/IFeeArena.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {WETH9} from "../src/mocks/WETH9.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter} from "../src/interfaces/ISwapRouter.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3Pool.sol";

/// @title DemoLive - V0-ONLY one-off live driver for a COMPLETE Fee Arena epoch on Arc testnet.
/// @notice **V0 ONLY - NOT for the V1 trustless deployment.**
///         This script drives the V0 mock-oracle deployment by hardcoding the V0 deployed
///         contract addresses and forcing the ETH/USD outcome via `MockPriceOracle.setPrice`
///         ("Force UP").  The V1 oracle is an immutable `PythPriceOracle` with no `setPrice`
///         function; this script cannot be used with a V1 deployment.
///         For the V1 live keeper flow see `script/keeper/post-and-crank.md`.
///
///         Drives the ALREADY-DEPLOYED V0 contracts (it deploys NOTHING) through a single
///         UP-win epoch, split into THREE separate broadcast entrypoints so the
///         controller can broadcast each phase and WAIT in between for the on-chain
///         timers (short demo windows of ~20s):
///
///           1. {setup}   - time-independent: wrap a little USDC->WETH, mint a full-range
///                          V3 position, set SHORT timings, create+open the epoch, stake UP.
///           2. {advance} - AFTER entry window closes: startEpoch, swap to accrue real
///                          fees, then Force UP via the oracle (so UP wins).
///           3. {settle}  - AFTER epoch end: endEpoch -> sweep -> finalize -> claim -> unstake.
///
///         Each entrypoint reads PRIVATE_KEY and broadcasts as that single account
///         (the "broadcaster"), mirroring Deploy.s.sol. via_ir is OFF: helpers are kept
///         stack-shallow. Amounts are intentionally TINY (the broadcaster holds only
///         ~18 testnet USDC total, shared with gas).
contract DemoLive is Script {
    // ---------------------------------------------------------------------
    // Deployed Arc-testnet addresses (hardcoded - this is a one-off for THIS deployment)
    // ---------------------------------------------------------------------
    address internal constant FEE_ARENA = 0x16a503891f8329EE999759e32Ae9fFF378f6c27d;
    address internal constant ORACLE = 0x30b864EF4E18A010fc826CA48143674Be8197BfA;
    address internal constant POOL = 0x87bDD5BE1f482D2Ba7D3FeA861e539DF9b2A610F;
    address internal constant NPM = 0x6fD9F3e1902b6a361f22b2391EAf42A0A6F031d2;
    address internal constant SWAP_ROUTER = 0x13B8d5fA0D48e96D6906E8F5B55bdb815901d24a;
    address internal constant FACTORY = 0x0d801DE7E559844257F4BbdAC242226Cd4C1d59b;
    address internal constant WETH = 0xc28c50aFf4E4ecE91c2F2DbA984ae5CdC9C2aC78;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;

    uint24 internal constant FEE_TIER = 3000;
    // Full-range ticks for tick spacing 60 (fee tier 0.30%).
    int24 internal constant TICK_LOWER = -887220;
    int24 internal constant TICK_UPPER = 887220;

    // ---- tiny demo amounts (broadcaster has ~18 testnet USDC total, shared w/ gas) ----
    uint256 internal constant WRAP_WETH = 0.01e18; // native USDC wrapped into WETH9 for the LP
    uint256 internal constant USDC_FOR_LP = 10e6; // bounded USDC approval/desired for the LP mint
    uint256 internal constant SWAP_WETH_IN = 0.0005e18; // tiny WETH->other-token swap to accrue fees

    // ---- short live timings so the controller's between-phase waits are ~20s ----
    uint32 internal constant ENTRY_WINDOW = 20;
    uint32 internal constant EPOCH_DURATION = 20;
    uint32 internal constant MIN_START_GAP = 4;
    uint32 internal constant MAX_START_DELAY = 3600;
    uint32 internal constant MAX_PRICE_AGE = 3600;

    // Side.UP == 1 (IFeeArena.Side { NONE=0, UP=1, DOWN=2, RANGE=3 }).
    uint8 internal constant SIDE_UP = 1;

    // =====================================================================
    // Phase 1: setup() - time-independent
    // =====================================================================

    /// @notice Wrap a little native USDC into WETH9, mint a full-range V3 position, set the
    ///         short demo timings, create+open an epoch, then stake the position UP.
    function setup() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        FeeArena arena = FeeArena(payable(FEE_ARENA));

        vm.startBroadcast(pk);

        // 1) Wrap a SMALL amount of native USDC into WETH9 (the LP's WETH leg).
        WETH9(payable(WETH)).deposit{value: WRAP_WETH}();

        // 2) Bounded (NOT MaxUint256) approvals to the NPM for both tokens.
        IERC20(WETH).approve(NPM, WRAP_WETH);
        IERC20(USDC).approve(NPM, USDC_FOR_LP);

        // 3) Mint a FULL-RANGE liquidity position to the broadcaster.
        uint256 tokenId = _mintFullRange(me);
        console2.log("setup: minted full-range tokenId :", tokenId);

        // 4) Short demo timings so the live waits are ~20s.
        arena.setTiming(ENTRY_WINDOW, EPOCH_DURATION, MIN_START_GAP, MAX_START_DELAY, MAX_PRICE_AGE);

        // 5) Create + open the epoch.
        uint64 epochId = arena.createEpoch();
        arena.openEntry();
        console2.log("setup: epochId :", uint256(epochId));

        // 6) Stake the position UP (onERC721Received decodes abi.encode(uint8 side)).
        INonfungiblePositionManager(NPM).safeTransferFrom(me, FEE_ARENA, tokenId, abi.encode(SIDE_UP));
        console2.log("setup: staked tokenId on side (1=UP) :", uint256(SIDE_UP));

        vm.stopBroadcast();
    }

    /// @dev Mint a full-range position with token0/token1 ordered per the live pool.
    ///      Desired amounts are mapped to the sorted ordering; mins are 0 (the NPM keeps
    ///      whatever the current price requires, refunding the rest of the approval).
    function _mintFullRange(address recipient) internal returns (uint256 tokenId) {
        address token0 = IUniswapV3Pool(POOL).token0();
        (uint256 amt0, uint256 amt1) = token0 == WETH ? (WRAP_WETH, USDC_FOR_LP) : (USDC_FOR_LP, WRAP_WETH);
        address token1 = token0 == WETH ? USDC : WETH;

        INonfungiblePositionManager.MintParams memory p = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: FEE_TIER,
            tickLower: TICK_LOWER,
            tickUpper: TICK_UPPER,
            amount0Desired: amt0,
            amount1Desired: amt1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: recipient,
            deadline: block.timestamp + 3600
        });
        (tokenId,,,) = INonfungiblePositionManager(NPM).mint(p);
    }

    // =====================================================================
    // Phase 2: advance() - AFTER the entry window has closed (controller waits)
    // =====================================================================

    /// @notice Start the running epoch, accrue REAL fees with a tiny swap, then Force UP via
    ///         the oracle so the UP side wins at settlement. Reads the epoch from the chain.
    function advance() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        FeeArena arena = FeeArena(payable(FEE_ARENA));
        uint64 epochId = arena.currentEpochId();
        console2.log("advance: epochId :", uint256(epochId));

        vm.startBroadcast(pk);

        // 1) Start the epoch (captures startPrice18 from the oracle).
        arena.startEpoch(new bytes[](0));

        IFeeArena.EpochView memory ev = arena.getEpoch(epochId);
        uint256 startPrice18 = ev.startPrice18;
        console2.log("advance: startPrice18 :", startPrice18);

        // 2) Accrue REAL fees with a tiny WETH-leg swap (WETH -> the pool's other token).
        _accrueFees();

        // 3) Force UP: push the oracle price above start by (band + margin) so OutcomeResolver
        //    yields UP. bandBps is read from the epoch (fallback 150 if somehow zero).
        int32 band = ev.bandBps;
        uint256 bandBps = band > 0 ? uint256(uint32(band)) : 150;
        uint256 settlePrice18 = startPrice18 + (startPrice18 * (bandBps + 50)) / 10_000;
        MockPriceOracle(ORACLE).setPrice(settlePrice18);
        console2.log("advance: bandBps :", bandBps);
        console2.log("advance: forced settlePrice18 (UP wins) :", settlePrice18);

        vm.stopBroadcast();
    }

    /// @dev One tiny exact-input swap on the WETH leg to accrue real pool fees. Wraps a little
    ///      more native USDC into WETH so the LP's WETH stake isn't touched, approves the router
    ///      for exactly the input, and swaps WETH -> the pool's other token.
    function _accrueFees() internal {
        // The pool's non-WETH leg (USDC in this WETH/USDC pool).
        address token0 = IUniswapV3Pool(POOL).token0();
        address tokenOut = token0 == WETH ? IUniswapV3Pool(POOL).token1() : token0;

        WETH9(payable(WETH)).deposit{value: SWAP_WETH_IN}();
        IERC20(WETH).approve(SWAP_ROUTER, SWAP_WETH_IN);

        ISwapRouter.ExactInputSingleParams memory sp = ISwapRouter.ExactInputSingleParams({
            tokenIn: WETH,
            tokenOut: tokenOut,
            fee: FEE_TIER,
            recipient: vm.addr(vm.envUint("PRIVATE_KEY")),
            deadline: block.timestamp + 3600,
            amountIn: SWAP_WETH_IN,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });
        uint256 out = ISwapRouter(SWAP_ROUTER).exactInputSingle(sp);
        console2.log("advance: swapped WETH-in, received other-token out :", out);
    }

    // =====================================================================
    // Phase 3: settle() - AFTER the epoch end time (controller waits)
    // =====================================================================

    /// @notice End -> sweep -> finalize the epoch, claim the broadcaster's UP reward, and
    ///         unstake (return) the NFT. Logs winning side, claimed amounts (balance deltas),
    ///         and a conservation check.
    function settle() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);

        FeeArena arena = FeeArena(payable(FEE_ARENA));
        uint64 epochId = arena.currentEpochId();
        uint256 tokenId = _myTokenIdForEpoch(arena, me, epochId);
        console2.log("settle: epochId :", uint256(epochId));
        console2.log("settle: my staked tokenId :", tokenId);

        vm.startBroadcast(pk);

        // 1) End (resolve) - payable but we send 0; the V0 oracle.update is a no-op.
        arena.endEpoch(new bytes[](0));

        IFeeArena.EpochView memory ev = arena.getEpoch(epochId);
        console2.log("settle: winningSide (1=UP,2=DOWN,3=RANGE) :", uint256(uint8(ev.winningSide)));
        console2.log("settle: settlePrice18 :", ev.settlePrice18);

        // 2) Sweep ALL staked positions (single staker, but keep it general/bounded).
        arena.sweep(100);

        // 3) Finalize (freeze winner denominator + inject any pending rollover once).
        arena.finalizeSettle();

        // 4) Claim the broadcaster's reward (pays the position owner). Measure deltas.
        uint256 wBefore = IERC20(WETH).balanceOf(me);
        uint256 uBefore = IERC20(USDC).balanceOf(me);
        arena.claim(uint256(epochId), tokenId);
        uint256 claimedW = IERC20(WETH).balanceOf(me) - wBefore;
        uint256 claimedU = IERC20(USDC).balanceOf(me) - uBefore;
        console2.log("settle: claimed WETH :", claimedW);
        console2.log("settle: claimed USDC :", claimedU);

        // 5) Unstake - return the NFT to the broadcaster.
        arena.unstake(tokenId);
        console2.log("settle: unstaked tokenId (NFT returned) :", tokenId);

        vm.stopBroadcast();

        // Conservation: a single UP winner with non-empty denominator claims the WHOLE pot.
        IFeeArena.EpochView memory post = arena.getEpoch(epochId);
        console2.log("settle: epoch potWETH :", post.potWETH);
        console2.log("settle: epoch potUSDC :", post.potUSDC);
        bool conserved = (claimedW == post.potWETH) && (claimedU == post.potUSDC);
        console2.log("settle: conservation (claimed == pot, sole winner) :", conserved);
    }

    /// @dev Find the broadcaster's staked tokenId for `epochId` via getUserStakes (filtered to
    ///      the epoch). Reverts if none found, surfacing a clear failure to the controller.
    function _myTokenIdForEpoch(FeeArena arena, address me, uint64 epochId) internal view returns (uint256) {
        IFeeArena.StakeView[] memory stakes = arena.getUserStakes(me);
        for (uint256 i = 0; i < stakes.length; ++i) {
            if (stakes[i].epochId == epochId) {
                return stakes[i].tokenId;
            }
        }
        revert("no staked tokenId for current epoch");
    }
}
