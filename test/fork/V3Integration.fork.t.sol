// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeArenaTestBase} from "test/utils/FeeArenaTestBase.sol";
import {V3Deployer, IUniswapV3PoolInit} from "test/utils/V3Deployer.sol";
import {WETH9} from "src/mocks/WETH9.sol";
import {TestERC20} from "src/mocks/TestERC20.sol";
import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {IUniswapV3Factory} from "src/interfaces/IUniswapV3Factory.sol";
import {INonfungiblePositionManager} from "src/interfaces/INonfungiblePositionManager.sol";
import {MaliciousReceiver} from "src/mocks/MaliciousReceiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Real-Uniswap-V3 integration tests. These deploy the unmodified =0.7.6
/// V3 fork locally in the Foundry EVM (no live RPC) and drive FeeArena over it.
/// The contract extends FeeArenaTestBase for the _deployWithRealV3/_mintRealPosition
/// /_accrueFees helpers, but overrides setUp() to a no-op: each test deploys its own
/// real-V3 fixture (the base's mock setUp is irrelevant here).
contract V3IntegrationTest is FeeArenaTestBase {
    function setUp() public override {
        // no-op: fork tests call _deployWithRealV3() (or new their own deps) per test.
    }

    // ---------------------------------------------------------------------
    // F3: deployer smoke test
    // ---------------------------------------------------------------------
    function test_V3Deployer_DeploysCoreContracts() public {
        WETH9 w = new WETH9();
        V3Deployer.V3 memory dep = V3Deployer.deploy(address(w));
        assertTrue(address(dep.factory) != address(0), "factory");
        assertTrue(address(dep.npm) != address(0), "npm");
        assertTrue(address(dep.router) != address(0), "router");
        // NPM must report the factory it was constructed with.
        assertEq(dep.npm.factory(), address(dep.factory), "npm.factory() wiring");
    }

    // ---------------------------------------------------------------------
    // F4: pool create + real mint + real swap accrues real fees
    // ---------------------------------------------------------------------
    function test_CreatePool_MintPosition_SwapAccruesFees() public {
        WETH9 w = new WETH9();
        TestERC20 u = new TestERC20("USD Coin", "USDC", 6);
        V3Deployer.V3 memory dep = V3Deployer.deploy(address(w));

        uint24 fee = 3000;
        uint160 sqrtPriceX96 = _sqrtPriceForPair(address(w), address(u));
        address pool = V3Deployer.createAndInitPool(dep, address(w), address(u), fee, sqrtPriceX96);
        assertTrue(pool != address(0), "pool");

        // fund this contract and mint a full-range position to itself
        vm.deal(address(this), 100 ether);
        w.deposit{value: 50 ether}();
        u.mint(address(this), 200_000e6);
        w.approve(address(dep.npm), type(uint256).max);
        u.approve(address(dep.npm), type(uint256).max);

        (uint256 tokenId, uint128 liq) =
            V3Deployer.mintPosition(dep, address(w), address(u), fee, address(this), 10 ether, 30_000e6);
        assertGt(liq, 0, "liquidity");

        // run a swap to generate fees
        address trader = makeAddr("trader");
        vm.deal(trader, 10 ether);
        vm.startPrank(trader);
        w.deposit{value: 5 ether}();
        w.approve(address(dep.router), type(uint256).max);
        uint256 out = V3Deployer.swapExactInput(dep, address(w), address(u), fee, trader, 1 ether);
        vm.stopPrank();
        assertGt(out, 0, "swap produced output");

        // collect accrued fees to self; at least one leg must be > 0 after a swap
        INonfungiblePositionManager.CollectParams memory cp = INonfungiblePositionManager.CollectParams({
            tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
        });
        (uint256 c0, uint256 c1) = dep.npm.collect(cp);
        assertTrue(c0 > 0 || c1 > 0, "no fees accrued after swap");
    }

    // ---------------------------------------------------------------------
    // F5: FeeArena constructor binds the real pool/factory/NPM
    // ---------------------------------------------------------------------
    function test_FeeArena_Constructor_BindsRealPoolAndFactory() public {
        _deployWithRealV3();
        assertEq(arena.POOL(), forkPool, "POOL immutable");
        assertEq(arena.FACTORY(), address(v3.factory), "FACTORY immutable");
        assertEq(arena.NPM(), address(v3.npm), "NPM immutable");
        // boot assert: FACTORY == NPM.factory()
        assertEq(arena.FACTORY(), v3.npm.factory(), "factory wiring assert");
        // wethIsToken0 resolved from POOL.token0()==WETH
        bool wethT0 = address(weth) < address(usdc);
        assertEq(uint256(arena.wethIsToken0()), wethT0 ? 1 : 0, "wethIsToken0 resolution");
        // WETH_NOTIONAL_DIV derived = 10**(18+18-6) = 1e30
        assertEq(arena.WETH_NOTIONAL_DIV(), 1e30, "WETH_NOTIONAL_DIV derivation");
    }

    // ---------------------------------------------------------------------
    // F6: atomic stake of a REAL position + factory.getPool / fee-tier validation
    // ---------------------------------------------------------------------
    function test_Stake_RealPosition_Succeeds_AndValidatesPool() public {
        _deployWithRealV3();
        address lp = makeAddr("lpUp");
        uint256 tokenId = _mintRealPosition(lp, 5 ether, 15_000e6);

        // open the epoch entry window
        vm.startPrank(owner);
        arena.createEpoch();
        arena.openEntry();
        vm.stopPrank();

        // atomic stake-with-side via safeTransferFrom (Side.UP == 1)
        vm.prank(lp);
        v3.npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(IFeeArena.Side.UP));

        // vault now owns the NFT; position recorded with side UP, swept=false
        assertEq(v3.npm.ownerOf(tokenId), address(arena), "vault owns NFT");
        IFeeArena.StakeView memory pos = arena.getStake(tokenId);
        assertEq(pos.owner, lp, "position owner");
        assertEq(uint8(pos.side), uint8(IFeeArena.Side.UP), "position side");
        assertEq(pos.swept, false, "not yet swept");
    }

    function test_Stake_WrongPool_Reverts_NotPool() public {
        _deployWithRealV3();
        // create a DIFFERENT pool (fee tier 500 is enabled by default in the canonical
        // factory; re-enabling reverts, so we just create the pool at that tier).
        uint24 otherFee = 500;
        address otherPool = v3.factory.createPool(address(weth), address(usdc), otherFee);
        IUniswapV3PoolInit(otherPool).initialize(forkSqrtPrice);

        address lp = makeAddr("lpWrong");
        vm.deal(lp, 6 ether);
        vm.startPrank(lp);
        weth.deposit{value: 5 ether}();
        vm.stopPrank();
        usdc.mint(lp, 15_000e6);
        vm.startPrank(lp);
        weth.approve(address(v3.npm), type(uint256).max);
        usdc.approve(address(v3.npm), type(uint256).max);
        // mint into the OTHER pool (fee 500), full range for spacing 10
        uint256 tokenId = _mintWrongPool(otherFee, lp);
        vm.stopPrank();

        vm.startPrank(owner);
        arena.createEpoch();
        arena.openEntry();
        vm.stopPrank();

        // staking a position from the wrong-fee pool must revert NotPool (fee != FEE_TIER)
        vm.prank(lp);
        vm.expectRevert(IFeeArena.NotPool.selector);
        v3.npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(IFeeArena.Side.UP));
    }

    /// @dev Mint a full-range position into the wrong-fee (500/spacing 10) pool. Built
    ///      via the local MintParams to dodge stack-too-deep in the test body.
    function _mintWrongPool(uint24 otherFee, address lp) internal returns (uint256 tokenId) {
        (address t0, address t1) =
            address(weth) < address(usdc) ? (address(weth), address(usdc)) : (address(usdc), address(weth));
        (uint256 a0, uint256 a1) = address(weth) < address(usdc)
            ? (uint256(5 ether), uint256(15_000e6))
            : (uint256(15_000e6), uint256(5 ether));
        INonfungiblePositionManager.MintParams memory p = INonfungiblePositionManager.MintParams({
            token0: t0,
            token1: t1,
            fee: otherFee,
            // spacing 10: max usable tick = floor(887272/10)*10 = 887270 (literals
            // pre-aligned; `(-887272/10)*10` constant-folds back to -887272, unaligned).
            tickLower: -887270,
            tickUpper: 887270,
            amount0Desired: a0,
            amount1Desired: a1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: lp,
            deadline: block.timestamp + 1
        });
        (tokenId,,,) = v3.npm.mint(p);
    }

    // ---------------------------------------------------------------------
    // F7: end-to-end sweep collects REAL Uniswap fees into the accounted pot
    // ---------------------------------------------------------------------
    function test_FullLifecycle_SweepCollectsRealFeesIntoPot() public {
        _deployWithRealV3();
        address lp = makeAddr("lpReal");
        uint256 tokenId = _mintRealPosition(lp, 10 ether, 30_000e6);

        // EntryOpen -> stake UP
        vm.startPrank(owner);
        arena.createEpoch();
        arena.openEntry();
        vm.stopPrank();
        vm.prank(lp);
        v3.npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(IFeeArena.Side.UP));

        // advance to start: now >= entryCloseTime; refresh price; permissionless startEpoch
        IFeeArena.EpochView memory ev0 = arena.currentEpoch();
        vm.warp(uint256(ev0.entryCloseTime) + 1);
        vm.roll(block.number + 1);
        _setOraclePrice(FORK_START_PRICE); // fresh at the start instant
        arena.startEpoch(new bytes[](0));

        // accrue real fees while Running
        _accrueFees(2 ether);

        // endTime reached -> set fresh settle price clearing +band (UP wins) -> endEpoch
        IFeeArena.EpochView memory ev1 = arena.getEpoch(ev0.epochId);
        vm.warp(uint256(ev1.endTime) + 1);
        vm.roll(block.number + 1);
        _setOraclePrice(3100e18); // +3.3% over start; > +1.5% band -> UP
        bytes[] memory empty = new bytes[](0);
        arena.endEpoch(empty);

        arena.sweep(100); // single batch covers the lone position
        (uint32 done, uint32 total) = arena.sweepProgress(ev0.epochId);
        assertEq(done, total, "sweep complete");

        arena.finalizeSettle();

        IFeeArena.EpochView memory ev2 = arena.getEpoch(ev0.epochId);
        assertEq(uint8(ev2.phase), uint8(IFeeArena.PhaseView.Settled), "Settled");
        assertTrue(ev2.potWETH > 0 || ev2.potUSDC > 0, "pot funded by real collected fees");
        assertEq(uint8(ev2.winningSide), uint8(IFeeArena.Side.UP), "UP wins");

        // the swept position carries realized fees and the range-normalized contribution6
        // (== real liquidity * real tickSpan from the V3 position itself).
        IFeeArena.StakeView memory pos = arena.getStake(tokenId);
        assertTrue(pos.swept, "position swept");
        (,,,,, int24 tl, int24 tu, uint128 liq,,,,) = v3.npm.positions(tokenId);
        uint256 expectC6 = uint256(liq) * uint256(uint24(tu - tl));
        assertEq(pos.contribution6, expectC6, "contribution == liquidity * tickSpan");
        // single winner: the frozen denominator equals that contribution.
        assertEq(ev2.winnerDenominator, expectC6, "winnerDenominator == the lone winner's liquidity * tickSpan");
        // pot legs == this single position's realized legs (one staker)
        assertEq(uint256(pos.feeWETH), ev2.potWETH, "potWETH == position feeWETH");
        assertEq(uint256(pos.feeUSDC), ev2.potUSDC, "potUSDC == position feeUSDC");
    }

    // ---------------------------------------------------------------------
    // F8: liveness — a reverting collect is skipped by the try/catch sweep
    // ---------------------------------------------------------------------
    function test_Sweep_SkipsRevertingCollect_NoBrick() public {
        _deployWithRealV3();
        address lpGood = makeAddr("lpGood");
        uint256 idGood = _mintRealPosition(lpGood, 5 ether, 15_000e6);
        address lpBad = makeAddr("lpBad");
        uint256 idBad = _mintRealPosition(lpBad, 5 ether, 15_000e6);

        vm.startPrank(owner);
        arena.createEpoch();
        arena.openEntry();
        vm.stopPrank();
        vm.prank(lpGood);
        v3.npm.safeTransferFrom(lpGood, address(arena), idGood, abi.encode(IFeeArena.Side.UP));
        vm.roll(block.number + 1); // one-action-per-block guard is per-address; advance anyway
        vm.prank(lpBad);
        v3.npm.safeTransferFrom(lpBad, address(arena), idBad, abi.encode(IFeeArena.Side.UP));

        IFeeArena.EpochView memory ev0 = arena.currentEpoch();
        vm.warp(uint256(ev0.entryCloseTime) + 1);
        vm.roll(block.number + 1);
        _setOraclePrice(FORK_START_PRICE);
        arena.startEpoch(new bytes[](0));
        _accrueFees(2 ether);

        // Make idBad's collect revert: mock the EXACT NPM.collect call sweep issues
        // (recipient = the arena vault, max/max), only for the bad tokenId.
        bytes memory badCollect = abi.encodeWithSelector(
            INonfungiblePositionManager.collect.selector,
            INonfungiblePositionManager.CollectParams({
                tokenId: idBad, recipient: address(arena), amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );
        vm.mockCallRevert(address(v3.npm), badCollect, "forced collect revert");

        vm.warp(uint256(arena.getEpoch(ev0.epochId).endTime) + 1);
        vm.roll(block.number + 1);
        _setOraclePrice(3100e18);
        arena.endEpoch(new bytes[](0));

        // sweep MUST NOT revert despite idBad reverting; it skips + marks it.
        arena.sweep(100);
        (uint32 done, uint32 total) = arena.sweepProgress(ev0.epochId);
        assertEq(done, total, "sweep completed past the bad position");
        arena.finalizeSettle();

        // bad position swept-marked with zero contribution; good one funded the pot.
        IFeeArena.StakeView memory bad = arena.getStake(idBad);
        assertTrue(bad.swept, "bad position marked swept");
        assertEq(bad.contribution6, 0, "bad position zero contribution");
        IFeeArena.StakeView memory good = arena.getStake(idGood);
        assertTrue(good.swept, "good position swept");
        // contribution == the REAL position's liquidity * tickSpan (range-normalized metric).
        (,,,,, int24 gtl, int24 gtu, uint128 gliq,,,,) = v3.npm.positions(idGood);
        assertEq(
            good.contribution6, uint256(gliq) * uint256(uint24(gtu - gtl)), "good contribution == liquidity * tickSpan"
        );
        vm.clearMockedCalls();
    }

    // ---------------------------------------------------------------------
    // F8: emergencySettle after endTime+GRACE recovers escrowed NFTs
    // ---------------------------------------------------------------------
    function test_EmergencySettle_AfterGrace_ReturnsNFTs() public {
        _deployWithRealV3();
        address lp = makeAddr("lpEmg");
        uint256 tokenId = _mintRealPosition(lp, 5 ether, 15_000e6);

        vm.startPrank(owner);
        arena.createEpoch();
        arena.openEntry();
        vm.stopPrank();
        vm.prank(lp);
        v3.npm.safeTransferFrom(lp, address(arena), tokenId, abi.encode(IFeeArena.Side.RANGE));

        IFeeArena.EpochView memory ev0 = arena.currentEpoch();
        vm.warp(uint256(ev0.entryCloseTime) + 1);
        vm.roll(block.number + 1);
        _setOraclePrice(FORK_START_PRICE);
        arena.startEpoch(new bytes[](0));

        // wedge: never run endEpoch; jump past endTime + GRACE and emergency-settle.
        IFeeArena.EpochView memory ev1 = arena.getEpoch(ev0.epochId);
        vm.warp(uint256(ev1.endTime) + uint256(arena.GRACE()) + 1);
        vm.roll(block.number + 1);
        vm.prank(owner);
        arena.emergencySettle(ev0.epochId, IFeeArena.Side.RANGE);

        // emergency marks positions swept -> owner recovers the NFT via unstake.
        vm.prank(lp);
        arena.unstake(tokenId);
        assertEq(v3.npm.ownerOf(tokenId), lp, "NFT recovered to LP after emergency");
    }

    // ---------------------------------------------------------------------
    // F8: reentrancy probe with a REAL NFT — nonReentrant blocks the re-entry
    // ---------------------------------------------------------------------
    function test_Reentrancy_OnUnstake_BlockedByGuard() public {
        _deployWithRealV3();
        MaliciousReceiver attacker = new MaliciousReceiver();

        // open the entry window first so the attacker's stake is accepted
        vm.startPrank(owner);
        arena.createEpoch();
        arena.openEntry();
        vm.stopPrank();

        // fund + mint a position OWNED by the attacker contract, then stake from it
        vm.deal(address(attacker), 6 ether);
        vm.prank(address(attacker));
        weth.deposit{value: 5 ether}();
        usdc.mint(address(attacker), 15_000e6);
        vm.startPrank(address(attacker));
        weth.approve(address(v3.npm), type(uint256).max);
        usdc.approve(address(v3.npm), type(uint256).max);
        uint256 tokenId = _mintForOwner(address(attacker), 5 ether, 15_000e6);
        v3.npm.safeTransferFrom(address(attacker), address(arena), tokenId, abi.encode(IFeeArena.Side.UP));
        vm.stopPrank();

        // run lifecycle to Settled so unstake is allowed
        IFeeArena.EpochView memory ev0 = arena.currentEpoch();
        vm.warp(uint256(ev0.entryCloseTime) + 1);
        vm.roll(block.number + 1);
        _setOraclePrice(FORK_START_PRICE);
        arena.startEpoch(new bytes[](0));
        _accrueFees(1 ether);
        vm.warp(uint256(arena.getEpoch(ev0.epochId).endTime) + 1);
        vm.roll(block.number + 1);
        _setOraclePrice(3100e18);
        arena.endEpoch(new bytes[](0));
        arena.sweep(100);
        arena.finalizeSettle();

        // arm the attacker to re-enter unstake during the NFT-return callback. The
        // MaliciousReceiver re-enters WITHOUT swallowing, so the inner nonReentrant
        // revert bubbles up through the safeTransferFrom and reverts the OUTER unstake.
        // The NFT stays escrowed and the position is not marked unstaked — proving the
        // guard blocked the double-exit with a REAL NFT.
        attacker.arm(address(arena), tokenId);
        vm.prank(address(attacker));
        vm.expectRevert();
        arena.unstake(tokenId);

        assertEq(v3.npm.ownerOf(tokenId), address(arena), "NFT still escrowed after blocked re-entry");
        assertEq(arena.getStake(tokenId).unstaked, false, "position not marked unstaked");
    }

    // ---------------------------------------------------------------------
    // F8: ERC721Enumerable confirm on the real NPM (else Transfer-log fallback)
    // ---------------------------------------------------------------------
    function test_NPM_SupportsERC721Enumerable_OrLogFallback() public {
        _deployWithRealV3();
        // ERC721Enumerable interfaceId = 0x780e9d63
        bool ok = IERC165(address(v3.npm)).supportsInterface(0x780e9d63);
        if (!ok) {
            emit log_string("NPM lacks ERC721Enumerable -> frontend must use Transfer-log enumeration");
        }
        // either way the NPM must be a valid ERC721 (0x80ac58cd)
        assertTrue(IERC165(address(v3.npm)).supportsInterface(0x80ac58cd), "NPM is ERC721");
    }

    /// @dev Mint a position for a contract owner (attacker) without re-pranking inside
    ///      (the caller has already started the prank + approvals).
    function _mintForOwner(address to, uint256 wethAmt, uint256 usdcAmt) internal returns (uint256 tokenId) {
        (tokenId,) = V3Deployer.mintPosition(v3, address(weth), address(usdc), ARENA_FEE_TIER, to, wethAmt, usdcAmt);
    }

    // ---------------------------------------------------------------------
    // local sqrt-price helper for the F4 standalone test
    // ---------------------------------------------------------------------
    function _sqrtPriceForPair(address w, address u) internal pure returns (uint160) {
        uint256 num;
        uint256 den;
        if (u < w) {
            num = 1e18;
            den = 3000e6;
        } else {
            num = 3000e6;
            den = 1e18;
        }
        uint256 ratioX192 = (num << 192) / den;
        return uint160(_isqrt(ratioX192));
    }
}
