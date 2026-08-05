// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {INonfungiblePositionManager} from "src/interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "src/interfaces/IUniswapV3Factory.sol";
import {IPriceOracle} from "src/interfaces/IPriceOracle.sol";
import {IPinnedPriceOracle} from "src/interfaces/IPinnedPriceOracle.sol";
import {EpochV2, Position, StakeStaging} from "src/FeeArenaV2Types.sol";

/// @title FeeArenaV2Staking - external stake VALIDATION for {FeeArenaV2} (EIP-170 extraction).
/// @notice Hosts the bytecode-heavy half of `onERC721Received`: the side decode + staged-conviction
///         bind, the window/same-block/one-side guards, the dust-flood caps, and the pool validation
///         (the external NPM.positions decode + factory.getPool check). Deployed separately and
///         DELEGATECALL-linked so this code leaves the arena's runtime. The arena's `onERC721Received`
///         keeps the NPM-only check + the nonReentrant/whenNotPaused guard, then does the cheap
///         fee-zeroing collect + Position write + events itself. Behavior is byte-identical.
library FeeArenaV2Staking {
    /// @dev Immutable pool/NPM config the validator needs (passed from the arena's immutables so the
    ///      library never holds state). One memory struct keeps the call's stack shallow (no via-ir).
    struct Cfg {
        address npm;
        address factory;
        address pool;
        uint24 feeTier;
        uint128 minLiquidity;
        uint32 maxStakesPerUser;
        uint32 maxStakesPerEpoch;
        uint64 currentEpochId;
    }

    /// @dev The validated stake facts the arena needs to record the Position (returned as a single
    ///      memory struct so the arena's call site stays within the legacy stack limit).
    struct Validated {
        IFeeArena.Side side;
        uint256 conviction;
        uint128 liq;
        uint32 span;
    }

    /// @dev onERC721Received Steps 2-6: decode/validate the side + bind the staged conviction, run
    ///      the window/same-block/one-side guards + caps, and validate the pool (capturing liquidity
    ///      + tickSpan). Returns them as one {Validated} struct. The arena performs Step 7 (collect)
    ///      + Steps 8-9 (record/emit) with these values.
    function checkAndValidate(
        EpochV2 storage ep,
        mapping(uint256 => Position) storage positions,
        mapping(address => mapping(uint64 => uint256[])) storage userEpochTokenIds,
        mapping(address => uint256) storage lastStakeBlock,
        mapping(uint256 => StakeStaging) storage stakeStaging,
        address from,
        uint256 tokenId,
        bytes calldata data,
        Cfg memory cfg
    ) public view returns (Validated memory v) {
        // Steps 2 + v2-staging: decode/validate the side AND bind the staged conviction.
        (v.side, v.conviction) = _decodeAndBindStaging(stakeStaging, from, tokenId, data);

        // Step 3: window guard (tie-tolerant: strict `<` on the close boundary).
        if (ep.phase != IFeeArena.Phase.EntryOpen) revert IFeeArena.NotEntryWindow();
        if (block.timestamp >= ep.entryCloseTime) revert IFeeArena.NotEntryWindow();

        // Step 4: one-action-per-block guard (per-wallet UX guard ONLY).
        if (lastStakeBlock[from] >= block.number) revert IFeeArena.SameBlock();

        // Step 5: one-side-per-LP-per-epoch (per-wallet UX guard ONLY).
        uint256 userCount = userEpochTokenIds[from][cfg.currentEpochId].length;
        if (userCount > 0) {
            if (v.side != positions[userEpochTokenIds[from][cfg.currentEpochId][0]].side) {
                revert IFeeArena.OneSidePerEpoch();
            }
        }

        // anti dust-flood caps. maxStakesPerEpoch is NON-ZERO in v2 (bounds the sweep).
        if (cfg.maxStakesPerUser != 0 && userCount + 1 > cfg.maxStakesPerUser) revert IFeeArena.CapExceeded();
        if (cfg.maxStakesPerEpoch != 0 && uint256(ep.stakedCount) + 1 > cfg.maxStakesPerEpoch) {
            revert IFeeArena.CapExceeded();
        }

        // Step 6: pool validation (factory.getPool) + staked liquidity / tick span capture.
        (v.liq, v.span) = _validatePool(tokenId, cfg);
    }

    /// @dev Step 2 (side decode) + the v2 staging bind. Reverts BadSideData/BadSide on a malformed
    ///      side, MissingConviction if no conviction was staged for this tokenId (or the converging
    ///      NFT owner != the staker), and StagedSideMismatch on a side swap.
    function _decodeAndBindStaging(
        mapping(uint256 => StakeStaging) storage stakeStaging,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) private view returns (IFeeArena.Side side, uint256 conviction) {
        if (data.length != 32) revert IFeeArena.BadSideData();
        uint8 raw = abi.decode(data, (uint8));
        if (raw < uint8(IFeeArena.Side.UP) || raw > uint8(IFeeArena.Side.RANGE)) revert IFeeArena.BadSide();
        side = IFeeArena.Side(raw);

        StakeStaging storage st = stakeStaging[tokenId];
        if (!st.pending) revert MissingConviction();
        if (st.staker != from) revert MissingConviction();
        if (st.side != side) revert StagedSideMismatch();
        conviction = st.conviction;
    }

    /// @dev Pool / fee-tier / MIN_LIQUIDITY validation. Pool checked via factory.getPool==POOL.
    function _validatePool(uint256 tokenId, Cfg memory cfg) private view returns (uint128 liquidity, uint32 tickSpan) {
        address t0;
        address t1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        (,, t0, t1, fee, tickLower, tickUpper, liquidity,,,,) = INonfungiblePositionManager(cfg.npm).positions(tokenId);
        if (fee != cfg.feeTier) revert IFeeArena.NotPool();
        if (IUniswapV3Factory(cfg.factory).getPool(t0, t1, fee) != cfg.pool) revert IFeeArena.NotPool();
        if (liquidity < cfg.minLiquidity) revert IFeeArena.InsufficientLiquidity();
        tickSpan = uint32(uint24(tickUpper - tickLower));
    }

    // =====================================================================
    // C4 ORACLE-CANDIDATE PROBE (moved out of proposeOracle; no arena storage needed).
    // =====================================================================

    /// @dev The C4 two-probe sanity check for a proposed oracle (the binding settle path is
    ///      getPinnedPrice, NOT getPrice - so we probe BOTH). Reverts OracleSanityFailed unless:
    ///        (1) IPriceOracle.getPrice staticcall succeeds AND returns >= two words; AND
    ///        (2) IPinnedPriceOracle.getPinnedPrice (empty updateData, impossible window minPub=1 >
    ///            maxPub=0) REVERTS with NON-EMPTY returndata - a conforming oracle reaches its own
    ///            typed error / Pyth's PriceFeedNotFoundWithinRange; a candidate MISSING the selector
    ///            either reverts empty (no fn / reverting fallback) or "succeeds" (non-reverting
    ///            fallback). A valid getPinnedPrice never succeeds this probe.
    function validateOracleCandidate(address newOracle) public view {
        (bool ok, bytes memory ret) = newOracle.staticcall(abi.encodeWithSelector(IPriceOracle.getPrice.selector));
        if (!ok || ret.length < 64) revert OracleSanityFailed();

        (bool okPin, bytes memory pinRet) = newOracle.staticcall(
            abi.encodeWithSelector(IPinnedPriceOracle.getPinnedPrice.selector, new bytes[](0), uint64(1), uint64(0))
        );
        if (okPin || pinRet.length == 0) revert OracleSanityFailed();
    }

    // ---- v2 staking errors (mirror the arena's; identical selectors). ----
    error MissingConviction();
    error StagedSideMismatch();
    error OracleSanityFailed();
}
