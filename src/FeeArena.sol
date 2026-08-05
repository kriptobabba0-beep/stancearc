// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IFeeArena} from "src/interfaces/IFeeArena.sol";
import {IPriceOracle} from "src/interfaces/IPriceOracle.sol";
import {INonfungiblePositionManager} from "src/interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "src/interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "src/interfaces/IUniswapV3Pool.sol";
import {OutcomeResolver} from "src/libraries/OutcomeResolver.sol";
import {EpochViewLib} from "src/libraries/EpochViewLib.sol";

// IERC20Decimals: minimal decimals() reader (USDC/WETH boot asserts).
interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title FeeArena - Fee Arena V0 core (lifecycle base; staking & settlement extend this file).
/// @notice Group L owns ALL storage, constants, immutables, the constructor, `struct Epoch`,
///         `struct Position`, and the create→open→start→end lifecycle cranks. Groups K
///         (staking) and M (settlement) extend THIS contract without re-declaring storage.
contract FeeArena is IFeeArena, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---- constants ----
    uint256 internal constant BPS = 10_000;
    bytes4 internal constant ERC721_RECEIVED = 0x150b7a02;
    uint8 public constant PRICE_DECIMALS = 18;

    uint32 public constant DEFAULT_ENTRY_WINDOW = 43_200;
    uint32 public constant DEFAULT_EPOCH_DURATION = 172_800;
    uint32 public constant DEMO_ENTRY_WINDOW = 120;
    uint32 public constant DEMO_EPOCH_DURATION = 300;
    uint32 public constant DEFAULT_MIN_START_GAP = 30;
    uint32 public constant DEFAULT_MAX_START_DELAY = 600;
    uint32 public constant DEFAULT_MAX_PRICE_AGE = 600;
    int32 public constant DEFAULT_BAND_BPS = 150;
    uint64 public constant GRACE = 600;

    /// @notice Gas forwarded to each NFT return in `unstakeBatch`. Generous for any real
    ///         wallet's onERC721Received (a Gnosis Safe needs <100k) while capping what a
    ///         hostile receiver can burn - it can park only ITSELF, never OOG the batch.
    ///         `internal` (no auto-getter): the contract sits within ~100 bytes of the
    ///         EIP-170 size limit, so every selector counts.
    uint256 internal constant AUTO_RETURN_GAS = 300_000;

    // ---- core immutables ----
    address public immutable USDC;
    address public immutable WETH;
    address public immutable POOL;
    address public immutable NPM;
    address public immutable FACTORY;
    address public immutable ORACLE;
    uint24 public immutable FEE_TIER;
    uint128 public immutable MIN_LIQUIDITY;
    uint256 public immutable WETH_NOTIONAL_DIV;
    uint8 public immutable wethIsToken0;

    // ---- mutable timing/band config (snapshotted into Epoch at create) ----
    uint32 public entryWindow;
    uint32 public epochDuration;
    uint32 public minStartGap;
    uint32 public maxStartDelay;
    uint32 public maxPriceAge;
    int32 public bandBps;
    uint32 public maxStakesPerEpoch;
    uint32 public maxStakesPerUser;

    // ---- epoch + position storage ----
    mapping(uint64 => Epoch) internal epochs;

    struct Position {
        address owner;
        uint64 epochId;
        Side side;
        bool swept;
        bool claimed;
        bool unstaked;
        uint128 feeWETH;
        uint128 feeUSDC;
        uint256 contribution6;
        // Staked in-range liquidity snapshotted at stake (read in _validatePool). The
        // winner-split metric `contribution6` is set to `liquidity * tickSpan` (gated on
        // the position realizing any fee = in-range proxy) at sweep, making the split
        // immune to wash-trading the fee amount AND to razor-thin tick-range concentration
        // (in V3 L ~ capital/(sqrtP_u - sqrtP_l) ~ capital/tickSpan near price, so
        // L*tickSpan ~ capital - share tracks deposited CAPITAL, not range tightness).
        // `tickSpan = tickUpper - tickLower` (V3 guarantees > 0). Placed LAST and packed
        // into ONE slot (128 + 32 bits) so the slot-0 offsets that the test vm.store
        // helpers + slot-layout test rely on are preserved.
        uint128 liquidity;
        uint32 tickSpan;
    }

    mapping(uint256 => Position) public positions;
    mapping(uint64 => uint256[]) internal epochTokenIds;
    mapping(address => mapping(uint64 => uint256[])) public userEpochTokenIds;
    mapping(address => uint256) public lastStakeBlock;

    uint64 public currentEpochId;
    uint64 public lastSettledEpochId;
    uint256 public rolloverWETH;
    uint256 public rolloverUSDC;

    /// @notice Least-privilege keeper allowed to run the epoch LIFECYCLE (createEpoch +
    ///         openEntry) ONLY. It may do nothing else - no config setters, no
    ///         pause/unpause, no emergencySettle, no setKeeper, no funds. Owner-set/cleared.
    address public keeper;

    /// @param c packed boot config (see {IFeeArena.BootConfig}). A single struct
    ///        param is used because the mixed 0.7.6/0.8.20 workspace forbids
    ///        via-ir and a flat 15-arg constructor overflows the legacy-pipeline
    ///        stack - the field set, immutables, asserts, and derivations are
    ///        otherwise identical to the original design.
    constructor(BootConfig memory c) Ownable() {
        // Boot validation isolated in a helper to keep the constructor stack shallow
        // (via-ir disabled). Returns the derived WETH->USDC notional divisor so we
        // read decimals exactly once.
        WETH_NOTIONAL_DIV = _bootValidate(c);

        // Tuple-assign the address immutables in one stack-frugal expression.
        (USDC, WETH, POOL, NPM, FACTORY, ORACLE) = (c.usdc, c.weth, c.pool, c.npm, c.factory, c.oracle);
        FEE_TIER = uint24(c.feeTier);
        MIN_LIQUIDITY = c.minLiquidity;
        wethIsToken0 = IUniswapV3Pool(c.pool).token0() == c.weth ? 1 : 0;

        _initTiming(c);
        _transferOwnership(c.owner);
    }

    /// @dev Boot asserts (ZeroAddress / BadDecimals / NotPool / BandOutOfRange) + the
    ///      derived WETH_NOTIONAL_DIV. Pulled out of the constructor body so the
    ///      constructor does not blow the legacy-pipeline stack.
    function _bootValidate(BootConfig memory c) private view returns (uint256 notionalDiv) {
        if (
            c.usdc == address(0) || c.weth == address(0) || c.pool == address(0) || c.npm == address(0)
                || c.factory == address(0) || c.oracle == address(0) || c.owner == address(0)
        ) revert ZeroAddress();

        uint8 ud = IERC20Decimals(c.usdc).decimals();
        uint8 wd = IERC20Decimals(c.weth).decimals();
        // USDC must be 6-dp (Arc native). The non-USDC leg (WETH / WBTC / any base token)
        // may have ANY decimals - e.g. 18-dp WETH or 8-dp WBTC. The former 18-dp requirement
        // on the non-USDC side only existed to derive WETH_NOTIONAL_DIV, which is now vestigial
        // (post-anti-manipulation the winner metric is liquidity×tickSpan, not USDC notional).
        // WETH_NOTIONAL_DIV is KEPT for ABI stability; its derivation `10**(wd+PRICE_DECIMALS-ud)`
        // already handles arbitrary wd correctly (e.g. wd=8 → 10**20, no overflow).
        if (ud != 6) revert BadDecimals();
        if (INonfungiblePositionManager(c.npm).factory() != c.factory) revert NotPool();
        if (c.bandBps <= 0 || c.bandBps >= int32(int256(BPS))) revert BandOutOfRange();

        // derived, NOT hardcoded - wd may be 8 (WBTC), 18 (WETH), or any other value.
        notionalDiv = 10 ** (uint256(wd) + uint256(PRICE_DECIMALS) - uint256(ud));
    }

    /// @dev Snapshot the mutable timing/band config. Offloaded from the constructor
    ///      body to keep the legacy-pipeline stack within limits.
    function _initTiming(BootConfig memory c) private {
        entryWindow = c.entryWindow;
        epochDuration = c.epochDuration;
        minStartGap = c.minStartGap;
        maxStartDelay = c.maxStartDelay;
        maxPriceAge = c.maxPriceAge;
        bandBps = c.bandBps;
    }

    // ---- keeper role (least-privilege lifecycle driver) ----

    /// @notice Set (or rotate, or clear via address(0)) the keeper allowed to run the
    ///         epoch LIFECYCLE (createEpoch + openEntry) ONLY. Owner-only; the keeper
    ///         can NOT call this. Lets a hot keeper key drive epochs while the owner key
    ///         stays cold (e.g. a multisig).
    function setKeeper(address newKeeper) external onlyOwner {
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    /// @dev Authorizes the epoch lifecycle to the owner OR the keeper. Used ONLY by
    ///      createEpoch/openEntry; every config/pause/emergency setter stays onlyOwner.
    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotOwnerOrKeeper();
        _;
    }

    // ---- owner config setters (future-epoch-only; snapshotted at createEpoch) ----

    function setTiming(
        uint32 entryWindow_,
        uint32 epochDuration_,
        uint32 minStartGap_,
        uint32 maxStartDelay_,
        uint32 maxPriceAge_
    ) external onlyOwner {
        entryWindow = entryWindow_;
        epochDuration = epochDuration_;
        minStartGap = minStartGap_;
        maxStartDelay = maxStartDelay_;
        maxPriceAge = maxPriceAge_;
        emit TimingUpdated(entryWindow_, epochDuration_, minStartGap_, maxStartDelay_, maxPriceAge_);
    }

    function setBand(int32 bandBps_) external onlyOwner {
        if (bandBps_ <= 0 || bandBps_ >= int32(int256(BPS))) revert BandOutOfRange();
        bandBps = bandBps_;
        emit BandUpdated(bandBps_);
    }

    function setStakeCaps(uint32 maxStakesPerEpoch_, uint32 maxStakesPerUser_) external onlyOwner {
        maxStakesPerEpoch = maxStakesPerEpoch_;
        maxStakesPerUser = maxStakesPerUser_;
        emit StakeCapsUpdated(maxStakesPerEpoch_, maxStakesPerUser_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---- lifecycle cranks ----

    function createEpoch() external onlyOwnerOrKeeper returns (uint64 epochId) {
        // sequential-only V0: previous must be Settled (or first epoch)
        if (currentEpochId != 0) {
            if (epochs[currentEpochId].phase != Phase.Settled) revert PrevNotSettled();
        }

        epochId = currentEpochId + 1;
        uint64 nowTs = uint64(block.timestamp);
        uint64 entryOpen = nowTs;
        uint64 entryClose = entryOpen + entryWindow;
        uint64 start = entryClose + minStartGap;
        uint64 end = start + epochDuration;

        // strict entryClose < start < end (also rejects degenerate single-ts epochs)
        if (!(entryClose < start && start < end)) revert BadTimes();
        int32 band = bandBps;
        if (band <= 0 || band >= int32(int256(BPS))) revert BandOutOfRange();

        Epoch storage e = epochs[epochId];
        e.phase = Phase.None; // created; openEntry flips to EntryOpen
        e.entryOpenTime = entryOpen;
        e.entryCloseTime = entryClose;
        e.startTime = start;
        e.endTime = end;
        e.bandBps = band;

        currentEpochId = epochId;
        emit EpochCreated(epochId, entryOpen, entryClose, start, end, band);
    }

    function openEntry() external onlyOwnerOrKeeper {
        Epoch storage e = epochs[currentEpochId];
        if (e.phase != Phase.None) revert WrongPhase();
        e.phase = Phase.EntryOpen;
    }

    function startEpoch(bytes[] calldata priceData) external payable nonReentrant whenNotPaused {
        uint256 balBefore = address(this).balance - msg.value;
        Epoch storage e = epochs[currentEpochId];
        if (e.phase != Phase.EntryOpen) revert WrongPhase();
        if (block.timestamp < e.entryCloseTime) revert StartTooEarly();
        if (block.timestamp > uint256(e.entryCloseTime) + maxStartDelay) revert StartDelayExceeded();

        IPriceOracle(ORACLE).update{value: msg.value}(priceData);
        (uint256 price18, uint256 updatedAt) = IPriceOracle(ORACLE).getPrice();
        _requireFresh(price18, updatedAt);
        if (updatedAt < e.entryCloseTime) revert StartPriceTooOld();

        e.startPrice18 = price18;
        e.startTimeActual = uint64(block.timestamp);
        e.phase = Phase.Running;
        emit EpochStarted(currentEpochId, price18, e.startTimeActual);
        _refundExcess(balBefore);
    }

    function endEpoch(bytes[] calldata priceData) external payable nonReentrant whenNotPaused {
        uint256 balBefore = address(this).balance - msg.value;
        Epoch storage e = epochs[currentEpochId];
        if (e.phase != Phase.Running) revert WrongPhase();
        if (block.timestamp < e.endTime) revert EpochNotEnded();

        IPriceOracle(ORACLE).update{value: msg.value}(priceData); // no-op V0
        (uint256 price18, uint256 updatedAt) = IPriceOracle(ORACLE).getPrice();
        _requireFresh(price18, updatedAt);
        if (updatedAt < e.endTime) revert SettlePriceTooOld();

        e.settlePrice18 = price18;
        e.settleTimeActual = uint64(block.timestamp);

        // single-sourced: decision delta == stored/emitted delta
        (Side winner, int256 delta) = OutcomeResolver.resolve(e.startPrice18, price18, e.bandBps);
        e.winningSide = winner;
        e.deltaBps = delta;
        e.phase = Phase.Resolved;

        emit EpochResolved(currentEpochId, price18, winner, delta, e.settleTimeActual);
        _refundExcess(balBefore);
    }

    function getEpoch(uint64 epochId) external view returns (EpochView memory) {
        return EpochViewLib.toView(
            epochId,
            epochs[epochId],
            rolloverWETH,
            rolloverUSDC,
            epochId == lastSettledEpochId + 1 && (rolloverWETH > 0 || rolloverUSDC > 0)
        );
    }

    function currentEpoch() external view returns (EpochView memory) {
        return EpochViewLib.toView(
            currentEpochId,
            epochs[currentEpochId],
            rolloverWETH,
            rolloverUSDC,
            currentEpochId == lastSettledEpochId + 1 && (rolloverWETH > 0 || rolloverUSDC > 0)
        );
    }

    // ---- staking (Group K) ----

    /// @notice ERC721 receiver hook = the single guarded stake recorder (spec §3.1).
    ///         Both `stakeWithSide` and a direct `NPM.safeTransferFrom` converge here.
    ///         `ERC721_RECEIVED` constant lives in L1.
    function onERC721Received(
        address,
        /*operator*/
        address from,
        uint256 tokenId,
        bytes calldata data
    )
        external
        nonReentrant
        whenNotPaused
        returns (bytes4)
    {
        // Step 1: only genuine V3 positions from the configured NPM.
        if (msg.sender != NPM) revert NotNPM();

        // Step 2: decode + validate side (one scheme; reject NONE; no enum panic on bad bytes).
        if (data.length != 32) revert BadSideData();
        uint8 raw = abi.decode(data, (uint8));
        if (raw < uint8(Side.UP) || raw > uint8(Side.RANGE)) revert BadSide();
        Side side = Side(raw);

        Epoch storage ep = epochs[currentEpochId];

        // Step 3: window guard (tie-tolerant: strict `<` on the close boundary).
        if (ep.phase != Phase.EntryOpen) revert NotEntryWindow();
        if (block.timestamp >= ep.entryCloseTime) revert NotEntryWindow();

        // Step 4: one-action-per-block guard (block.number monotonic on Arc).
        if (lastStakeBlock[from] >= block.number) revert SameBlock();

        // Step 5: one-side-per-LP-per-epoch - existing stakes this epoch must share the side.
        uint256[] storage mine = userEpochTokenIds[from][currentEpochId];
        uint256 userCount = mine.length;
        if (userCount > 0) {
            Side existing = positions[mine[0]].side;
            if (side != existing) revert OneSidePerEpoch();
        }

        // anti dust-flood caps (0 == unlimited).
        if (maxStakesPerUser != 0 && userCount + 1 > maxStakesPerUser) revert CapExceeded();
        if (maxStakesPerEpoch != 0 && uint256(ep.stakedCount) + 1 > maxStakesPerEpoch) revert CapExceeded();

        // Step 6: pool validation via factory.getPool (offloaded to a helper to keep the
        // legacy-pipeline stack shallow - via-ir disabled in the mixed-solc workspace).
        // Capture the staked liquidity + tick span: the (wash-trade-immune,
        // range-concentration-immune) winner-split metric is `liq * span`.
        (uint128 liq, uint32 span) = _validatePool(tokenId);

        // Step 7 (fairness, must-fix #1): zero pre-existing fees to the LP so only
        // [stake, endEpoch] fees count as contribution.
        INonfungiblePositionManager(NPM)
            .collect(
                INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: from, amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
            );

        // Steps 8-9: record + counters + event, return selector.
        _recordStake(ep, from, tokenId, side, liq, span);
        return ERC721_RECEIVED;
    }

    /// @notice Return an escrowed NFT to its owner once the epoch is fully Settled and
    ///         the position has been swept (spec §3.3, must-fix #8). CEI: effects before
    ///         the NFT transfer, which is LAST; `nonReentrant` blocks the receiver hook
    ///         from re-entering. Reward payout is the separate two-step claim() (guarded
    ///         by Position.claimed) - NOT auto-claimed here.
    function unstake(uint256 tokenId) external nonReentrant {
        Position storage p = positions[tokenId];
        // owner gate (also rejects already-unstaked: a returned NFT can't be re-unstaked)
        if (p.owner != msg.sender || p.unstaked) revert NotOwner();

        Epoch storage ep = epochs[p.epochId];
        if (ep.phase != Phase.Settled) revert NotSettled();
        if (!p.swept) revert NotSwept();

        // EFFECTS before INTERACTION (CEI).
        p.unstaked = true;
        emit Unstaked(p.epochId, p.owner, tokenId);

        // INTERACTION LAST: return the NFT to its owner.
        INonfungiblePositionManager(NPM).safeTransferFrom(address(this), p.owner, tokenId);
    }

    /// @notice Thin convenience wrapper: pulls the NFT and converges on the guarded
    ///         onERC721Received recorder via the NPM safe-transfer callback. No
    ///         `nonReentrant` here - the recorder it converges on is already guarded.
    function stakeWithSide(uint256 tokenId, Side side) external {
        INonfungiblePositionManager(NPM).safeTransferFrom(msg.sender, address(this), tokenId, abi.encode(side));
    }

    /// @dev Pool / fee-tier / MIN_LIQUIDITY validation (spec §3.1 step 6, must-fix #2).
    ///      Pool is checked via factory.getPool(t0,t1,fee)==POOL (no init-code-hash
    ///      hazard). Isolated in a helper so onERC721Received's stack stays within the
    ///      legacy-pipeline limit (via-ir disabled).
    function _validatePool(uint256 tokenId) private view returns (uint128 liquidity, uint32 tickSpan) {
        address t0;
        address t1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        (,, t0, t1, fee, tickLower, tickUpper, liquidity,,,,) = INonfungiblePositionManager(NPM).positions(tokenId);
        if (fee != FEE_TIER) revert NotPool();
        if (IUniswapV3Factory(FACTORY).getPool(t0, t1, fee) != POOL) revert NotPool();
        if (liquidity < MIN_LIQUIDITY) revert InsufficientLiquidity();
        // V3 guarantees tickUpper > tickLower, so the span is >= 1. The range-normalized
        // metric `liquidity * tickSpan` is a capital proxy that defeats tick concentration.
        tickSpan = uint32(uint24(tickUpper - tickLower));
        return (liquidity, tickSpan);
    }

    function _recordStake(
        Epoch storage ep,
        address from,
        uint256 tokenId,
        Side side,
        uint128 liquidity,
        uint32 tickSpan
    ) internal {
        positions[tokenId] = Position({
            owner: from,
            epochId: currentEpochId,
            side: side,
            swept: false,
            claimed: false,
            unstaked: false,
            feeWETH: 0,
            feeUSDC: 0,
            contribution6: 0,
            liquidity: liquidity,
            tickSpan: tickSpan
        });
        epochTokenIds[currentEpochId].push(tokenId);
        userEpochTokenIds[from][currentEpochId].push(tokenId);
        lastStakeBlock[from] = block.number;
        ep.stakedCount += 1;
        emit Staked(currentEpochId, from, tokenId, side, ep.stakedCount);
    }

    // ---- staking views (Group K) ----

    /// @notice Read-optimized projection of a staked Position (spec §3.2). Reads the
    ///         canonical `positions` mapping declared in L1. Returns a zeroed view
    ///         (with the queried tokenId echoed) for never-staked token IDs.
    function getStake(uint256 tokenId) external view returns (IFeeArena.StakeView memory s) {
        Position storage p = positions[tokenId];
        s = IFeeArena.StakeView({
            tokenId: tokenId,
            owner: p.owner,
            epochId: p.epochId,
            side: p.side,
            swept: p.swept,
            claimed: p.claimed,
            unstaked: p.unstaked,
            feeWETH: p.feeWETH,
            feeUSDC: p.feeUSDC,
            contribution6: p.contribution6
        });
    }

    // =====================================================================
    // Group M - settlement back-half: sweep, finalizeSettle, claim, rollover,
    // foldDust, emergencySettle, solvency invariant, and read-side views.
    // Extends (does NOT redeclare) the L+K storage above.
    // =====================================================================

    /// @notice Staked positions on the winning side WITH contribution6 > 0 (gates foldDust).
    mapping(uint64 => uint32) public winnerCount;

    /// @notice Settled epochs whose pots are still (partly) unclaimed - summed by the
    ///         solvency invariant. V0 bounded sequential chains keep this small.
    uint64[] internal settledEpochIds;

    /// @notice Auto-return progress per epoch: count of `epochTokenIds` entries the
    ///         permissionless `unstakeBatch` crank has processed (parked tokens included -
    ///         they are skipped once and stay owner-pullable via `unstake`). Declared LAST
    ///         so every pre-existing storage slot keeps its offset (slot-layout test).
    mapping(uint64 => uint32) public unstakeCursor;

    // ---- M2: paginated try/catch sweep ----

    /// @notice Sweep (collect to vault) up to `maxCount` staked positions of the current
    ///         (last-resolved) epoch, accumulating pot + per-side contribution. A reverting
    ///         `collect` is isolated by try/catch (marked swept, zero contribution) so a
    ///         single bad position can never brick the epoch. Resumable via `sweepCursor`;
    ///         flips Resolved -> Swept on the final batch.
    function sweep(uint256 maxCount) external nonReentrant whenNotPaused {
        uint64 id = currentEpochId;
        Epoch storage e = epochs[id];
        if (e.phase == Phase.Swept || e.phase == Phase.Settled) revert SweepAlreadyDone();
        if (e.phase != Phase.Resolved) revert WrongPhase();
        if (e.settlePrice18 == 0) revert ZeroPrice();

        uint256[] storage ids = epochTokenIds[id];
        uint32 cursor = e.sweepCursor;
        uint32 total = e.stakedCount;
        uint256 end = uint256(cursor) + maxCount;
        if (end > total) end = total;

        for (uint256 i = cursor; i < end; ++i) {
            uint256 tokenId = ids[i];
            Position storage p = positions[tokenId];
            if (p.swept) continue; // defensive; cursor normally guarantees not-yet-swept
            try this.externalCollect(tokenId) returns (uint256 feeWeth, uint256 feeUsdc) {
                uint128 fw = SafeCast.toUint128(feeWeth);
                uint128 fu = SafeCast.toUint128(feeUsdc);
                // Anti-wash-trade + anti-range-concentration: split by RANGE-NORMALIZED
                // staked liquidity `liquidity * tickSpan` (a capital proxy), gated on the
                // position realizing ANY fee (an in-range/active proxy), NOT by the fee
                // USDC-notional (gameable). Out-of-range positions realize 0 fees =>
                // contribution 0. Both liquidity and tickSpan are fixed at stake, so neither
                // wash-trading the fee amount nor minting a razor-thin tick range (which
                // inflates L per dollar) can change the pot share. No overflow:
                // uint128 * uint32 <= ~6e44 << 2^256.
                uint256 c6 = (fw > 0 || fu > 0) ? uint256(p.liquidity) * uint256(p.tickSpan) : 0;
                p.feeWETH = fw;
                p.feeUSDC = fu;
                p.contribution6 = c6;
                p.swept = true;
                e.potWETH += feeWeth;
                e.potUSDC += feeUsdc;
                e.sideContribution6[uint256(uint8(p.side))] += c6;
                emit Swept(id, tokenId, fw, fu, c6);
            } catch {
                p.swept = true; // mark-and-skip; zero contribution
                emit SweepFailed(id, tokenId);
            }
        }
        e.sweepCursor = uint32(end);
        emit SweepProgressed(id, e.sweepCursor, total);
        if (e.sweepCursor == total) {
            e.phase = Phase.Swept;
            emit EpochSwept(id, e.potWETH, e.potUSDC);
        }
        _assertSolvent();
    }

    /// @notice External-self wrapper so a reverting `NPM.collect` is isolated by the
    ///         try/catch in `sweep`. Returns fees ordered as (WETH-leg, USDC-leg).
    function externalCollect(uint256 tokenId) external returns (uint256 feeWeth, uint256 feeUsdc) {
        require(msg.sender == address(this), "self");
        (uint256 a0, uint256 a1) = INonfungiblePositionManager(NPM)
            .collect(
                INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
            );
        (feeWeth, feeUsdc) = wethIsToken0 == 1 ? (a0, a1) : (a1, a0);
    }

    /// @notice (done, total) sweep progress for an epoch.
    function sweepProgress(uint64 epochId) external view returns (uint32 done, uint32 total) {
        Epoch storage e = epochs[epochId];
        return (e.sweepCursor, e.stakedCount);
    }

    // ---- M2b: paginated try/catch auto-return (push-based unstake) ----

    /// @notice AUTO-RETURN (permissionless): push up to `maxCount` escrowed NFTs of a
    ///         Settled epoch back to their owners, so users get positions back without a
    ///         manual unstake transaction (the keeper cranks this after finalizeSettle).
    ///         Mirrors `sweep`'s resumable-cursor + try/catch isolation: a receiver that
    ///         reverts (or burns > AUTO_RETURN_GAS) is SKIPPED and *parked* - its position
    ///         stays escrowed and owner-pullable via `unstake` - so one bad receiver can
    ///         never block anyone else's return. Payouts are untouched: `claim` pays
    ///         `Position.owner` and never reads `unstaked`, so claiming before or after
    ///         the auto-return both work. Tokens already pulled manually are skipped.
    ///         Every staked token of a Settled epoch is swept by construction
    ///         (finalizeSettle requires sweepCursor == stakedCount), so the per-token
    ///         `swept` gate of manual unstake is implied by the phase gate here.
    function unstakeBatch(uint64 epochId, uint256 maxCount) external nonReentrant whenNotPaused {
        Epoch storage e = epochs[epochId];
        if (e.phase != Phase.Settled) revert NotSettled();

        uint256[] storage ids = epochTokenIds[epochId];
        uint32 cursor = unstakeCursor[epochId];
        uint32 total = e.stakedCount;
        uint256 end = uint256(cursor) + maxCount;
        if (end > total) end = total;

        for (uint256 i = cursor; i < end; ++i) {
            uint256 tokenId = ids[i];
            Position storage p = positions[tokenId];
            if (p.unstaked) continue; // already pulled manually via unstake()
            // EFFECTS before INTERACTION (CEI), exactly like unstake(). A failed sub-call
            // reverts only ITS frame, not ours - so the catch arm un-marks explicitly.
            p.unstaked = true;
            try this.externalReturn{gas: AUTO_RETURN_GAS}(p.owner, tokenId) {
                emit Unstaked(epochId, p.owner, tokenId);
            } catch {
                // Park: leave the position escrowed + owner-pullable via unstake().
                // The cursor still advances - a hostile receiver is never retried.
                p.unstaked = false;
                emit AutoUnstakeFailed(epochId, p.owner, tokenId);
            }
        }
        unstakeCursor[epochId] = uint32(end);
        emit UnstakeProgressed(epochId, uint32(end), total);
    }

    /// @notice External-self wrapper so a reverting NFT return is isolated by the
    ///         try/catch in `unstakeBatch` (same pattern as `externalCollect`).
    ///         NOTE: no `unstakeProgress` view twin of `sweepProgress` - the contract is
    ///         within ~100 bytes of the EIP-170 size limit, and the same pair is already
    ///         readable as (`unstakeCursor(epochId)`, `sweepProgress(epochId).total`).
    function externalReturn(address to, uint256 tokenId) external {
        require(msg.sender == address(this), "self");
        INonfungiblePositionManager(NPM).safeTransferFrom(address(this), to, tokenId);
    }

    // ---- M4: finalizeSettle (rollover inject once, denominator freeze, empty-winner) ----

    /// @notice Finalize the next-in-order Swept epoch: inject any pending rollover EXACTLY
    ///         once, then either roll the whole pot forward (empty winner: winning-side
    ///         contribution == 0) or freeze `winnerDenominator`. Swept -> Settled.
    function finalizeSettle() external nonReentrant whenNotPaused {
        uint64 id = lastSettledEpochId + 1;
        Epoch storage e = epochs[id];
        if (e.phase != Phase.Swept) revert WrongPhase();
        if (e.sweepCursor != e.stakedCount) revert SweepNotComplete();

        _injectRolloverOnce(id, e);

        Side w = e.winningSide;
        uint256 s = e.sideContribution6[uint256(uint8(w))];
        if (s == 0) {
            // empty winner: roll the whole (post-inject) pot forward, no division
            e.rolledOver = true;
            rolloverWETH += e.potWETH;
            rolloverUSDC += e.potUSDC;
            emit EmptyWinnerRollover(id, w, e.potWETH, e.potUSDC);
        } else {
            e.winnerDenominator = s;
            // count winners with positive contribution (gates foldDust)
            uint256[] storage ids = epochTokenIds[id];
            uint32 wc;
            uint256 n = ids.length;
            for (uint256 i = 0; i < n; ++i) {
                Position storage pp = positions[ids[i]];
                if (pp.side == w && pp.contribution6 > 0) ++wc;
            }
            winnerCount[id] = wc;
        }
        settledEpochIds.push(id);
        e.phase = Phase.Settled;
        lastSettledEpochId = id;
        emit EpochSettled(id, w, e.winnerDenominator, e.potWETH, e.potUSDC);
        _assertSolvent();
    }

    /// @dev Inject the pending global rollover into this epoch's pot exactly once.
    function _injectRolloverOnce(uint64 id, Epoch storage e) internal {
        if (e.rolloverConsumed) revert RolloverAlreadyConsumed();
        e.rolloverConsumed = true;
        uint256 rw = rolloverWETH;
        uint256 ru = rolloverUSDC;
        if (rw != 0 || ru != 0) {
            e.potWETH += rw;
            e.potUSDC += ru;
            rolloverWETH = 0;
            rolloverUSDC = 0;
            emit RolloverInjected(id, rw, ru);
        }
    }

    // ---- M5: pull-based mixed claim ----

    /// @notice Pull-based mixed (WETH+USDC) payout to the position's OWNER (regardless of
    ///         caller). Floor `mulDiv`; EFFECTS before INTERACTIONS; single payout guarded
    ///         by `Position.claimed`.
    function claim(uint256 epochId, uint256 tokenId) external nonReentrant {
        Epoch storage e = epochs[uint64(epochId)];
        if (e.phase != Phase.Settled) revert NotSettled();
        if (e.rolledOver) revert AlreadyRolledOver();
        if (e.sweepCursor != e.stakedCount) revert SweepNotComplete();

        Position storage p = positions[tokenId];
        if (p.epochId != uint64(epochId)) revert WrongPhase();
        if (p.side != e.winningSide) revert WrongSide();
        if (p.claimed) revert AlreadyClaimed();
        // A winning position whose sweep `collect` reverted is marked swept with zero
        // contribution. It is owed nothing and is NOT counted in `winnerCount`, so it
        // must never bump `claimedCount` (which would brick foldDust's NotAllClaimed gate).
        if (p.contribution6 == 0) revert NothingToClaim();

        _settleReward(uint64(epochId), tokenId, e, p);
    }

    /// @dev Single payout path. Idempotent + side-guarded so claim pays AT MOST once.
    function _settleReward(uint64 epochId, uint256 tokenId, Epoch storage e, Position storage p) internal {
        if (p.claimed) return; // idempotent guard
        if (p.side != e.winningSide) return; // losers get nothing
        uint256 denom = e.winnerDenominator;
        if (denom == 0) return; // empty-winner: nothing to pay

        uint256 payWETH = Math.mulDiv(e.potWETH, p.contribution6, denom); // floor
        uint256 payUSDC = Math.mulDiv(e.potUSDC, p.contribution6, denom); // floor

        // EFFECTS FIRST
        p.claimed = true;
        e.claimedWETH += payWETH;
        e.claimedUSDC += payUSDC;
        e.claimedCount += 1;

        // INTERACTIONS LAST
        _payout(p.owner, payWETH, payUSDC);
        emit Claimed(epochId, p.owner, tokenId, payWETH, payUSDC);
        _assertSolvent();
    }

    function _payout(address to, uint256 wethAmt, uint256 usdcAmt) internal {
        if (wethAmt > 0) IERC20(WETH).safeTransfer(to, wethAmt);
        if (usdcAmt > 0) IERC20(USDC).safeTransfer(to, usdcAmt);
    }

    // ---- M6: foldDust (residual from floor) ----

    /// @notice After every winner has claimed, roll the floor-residual dust forward to the
    ///         global rollover. Dust is computed from accounted counters, never balanceOf.
    function foldDust(uint64 epochId) external nonReentrant {
        Epoch storage e = epochs[epochId];
        if (e.phase != Phase.Settled) revert NotSettled();
        if (e.rolledOver) revert AlreadyRolledOver();
        if (e.claimedCount != winnerCount[epochId]) revert NotAllClaimed();

        uint256 dustWETH = e.potWETH - e.claimedWETH; // exact, from counters
        uint256 dustUSDC = e.potUSDC - e.claimedUSDC;
        if (dustWETH == 0 && dustUSDC == 0) revert NothingToFold();

        // drain the residual via counters so a second call has nothing left to fold
        e.claimedWETH = e.potWETH;
        e.claimedUSDC = e.potUSDC;
        rolloverWETH += dustWETH;
        rolloverUSDC += dustUSDC;
        emit DustFolded(epochId, dustWETH, dustUSDC);
        _assertSolvent();
    }

    // ---- M9: emergencySettle (terminal escape hatch) ----

    /// @notice Owner-only terminal recovery for a wedged epoch after `endTime + GRACE`.
    ///         Marks every position swept (so NFTs are unstakeable), rolls whatever pot was
    ///         realized forward (no division, no treasury), injects any pending rollover once.
    function emergencySettle(uint64 epochId, Side resolution) external onlyOwner nonReentrant whenNotPaused {
        Epoch storage e = epochs[epochId];
        if (e.phase == Phase.Settled || e.phase == Phase.None) revert WrongPhase();
        // A determined winner exists iff endEpoch ran (settlePrice18 != 0). The hatch is
        // ONLY for genuinely-unresolved/wedged epochs (EntryOpen/Running, settlePrice18 == 0);
        // a Resolved/Swept epoch can already be driven to Settled via sweep+finalizeSettle, so
        // emergencySettle must never confiscate its determined winner's pot.
        if (e.settlePrice18 != 0) revert WrongPhase();
        if (block.timestamp <= uint256(e.endTime) + GRACE) revert GraceNotElapsed();
        if (e.rolloverConsumed) revert RolloverAlreadyConsumed();

        uint256[] storage ids = epochTokenIds[epochId];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; ++i) {
            positions[ids[i]].swept = true;
        }
        e.sweepCursor = e.stakedCount;
        e.winningSide = resolution; // outcome is "rolled", not divided

        _injectRolloverOnce(epochId, e);
        e.rolledOver = true;
        rolloverWETH += e.potWETH;
        rolloverUSDC += e.potUSDC;

        settledEpochIds.push(epochId);
        e.phase = Phase.Settled;
        if (epochId == lastSettledEpochId + 1) lastSettledEpochId = epochId;
        emit EmergencySettled(epochId, resolution);
        _assertSolvent();
    }

    // ---- M7: solvency invariant ----

    /// @notice Vault must hold at least the unclaimed pot of every still-open settled epoch
    ///         plus the global rollover, for BOTH assets. Never derives pot from balanceOf,
    ///         so donations only ever increase the safety margin. Rolled-over epochs are
    ///         skipped (their pot is already represented inside the rollover globals).
    function _assertSolvent() internal view {
        uint256 needWETH = rolloverWETH;
        uint256 needUSDC = rolloverUSDC;
        uint256 n = settledEpochIds.length;
        for (uint256 i = 0; i < n; ++i) {
            Epoch storage e = epochs[settledEpochIds[i]];
            if (e.rolledOver) continue; // pot already counted inside rollover
            needWETH += (e.potWETH - e.claimedWETH);
            needUSDC += (e.potUSDC - e.claimedUSDC);
        }
        require(IERC20(WETH).balanceOf(address(this)) >= needWETH, "INSOLVENT_WETH");
        require(IERC20(USDC).balanceOf(address(this)) >= needUSDC, "INSOLVENT_USDC");
    }

    // ---- M10: read-side views (getStakesByEpoch / getUserStakes / previewClaim) ----

    /// @notice All staked-position projections for an epoch.
    function getStakesByEpoch(uint64 epochId) external view returns (StakeView[] memory out) {
        uint256[] storage ids = epochTokenIds[epochId];
        out = new StakeView[](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            out[i] = _stakeView(ids[i]);
        }
    }

    /// @notice All staked-position projections owned by `user` across epochs [1..current].
    function getUserStakes(address user) external view returns (StakeView[] memory out) {
        uint64 cur = currentEpochId;
        uint256 count;
        for (uint64 ep = 1; ep <= cur; ++ep) {
            count += userEpochTokenIds[user][ep].length;
        }
        out = new StakeView[](count);
        uint256 k;
        for (uint64 ep = 1; ep <= cur; ++ep) {
            uint256[] storage ids = userEpochTokenIds[user][ep];
            for (uint256 i = 0; i < ids.length; ++i) {
                out[k++] = _stakeView(ids[i]);
            }
        }
    }

    /// @notice Floor projection of a winner's claim - mirrors `claim()` math exactly.
    function previewClaim(uint64 epochId, uint256 tokenId) external view returns (ClaimPreview memory pv) {
        Epoch storage e = epochs[epochId];
        Position storage p = positions[tokenId];
        pv.contribution6 = p.contribution6;
        pv.winnerDenominator = e.winnerDenominator;
        pv.isWinner =
            (e.phase >= Phase.Resolved) && (p.side == e.winningSide) && (p.epochId == epochId) && (p.side != Side.NONE);
        pv.alreadyClaimed = p.claimed;
        bool settledDone = (e.phase == Phase.Settled) && !e.rolledOver && (e.sweepCursor == e.stakedCount);
        // Gate claimable on a POSITIVE contribution: a winning-side position that realized
        // no fee (out-of-range / reverted collect) has contribution6 == 0 and claim()
        // reverts NothingToClaim, so it is not actually claimable. `isWinner` stays as-is
        // (keeps the wrong-side vs right-side distinction); only `claimable` tightens.
        pv.claimable = settledDone && pv.isWinner && !p.claimed && p.contribution6 > 0;
        if (pv.isWinner && e.winnerDenominator != 0) {
            pv.payWETH = Math.mulDiv(e.potWETH, p.contribution6, e.winnerDenominator);
            pv.payUSDC = Math.mulDiv(e.potUSDC, p.contribution6, e.winnerDenominator);
        }
    }

    /// @dev Shared StakeView builder for the M views (mirrors K2's getStake).
    function _stakeView(uint256 tokenId) internal view returns (StakeView memory s) {
        Position storage p = positions[tokenId];
        s = StakeView({
            tokenId: tokenId,
            owner: p.owner,
            epochId: p.epochId,
            side: p.side,
            swept: p.swept,
            claimed: p.claimed,
            unstaked: p.unstaked,
            feeWETH: p.feeWETH,
            feeUSDC: p.feeUSDC,
            contribution6: p.contribution6
        });
    }

    // ---- internal helpers (shared with groups K & M) ----
    function _epoch(uint64 id) internal view returns (Epoch storage) {
        return epochs[id];
    }

    /// @dev Return ONLY the native that the oracle refunded for THIS crank (msg.value - fee),
    ///      never any pre-existing/donated balance. FeeArena holds no native between cranks.
    function _refundExcess(uint256 balBefore) internal {
        uint256 bal = address(this).balance;
        if (bal > balBefore) {
            (bool ok,) = payable(msg.sender).call{value: bal - balBefore}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Accept the oracle's fee refund. No other native ETH is expected.
    receive() external payable {}

    function _requireFresh(uint256 price18, uint256 updatedAt) internal view {
        if (price18 == 0) revert ZeroPrice();
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice();
    }
}
