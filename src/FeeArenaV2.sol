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
import {IPinnedPriceOracle} from "src/interfaces/IPinnedPriceOracle.sol";
import {INonfungiblePositionManager} from "src/interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "src/interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "src/interfaces/IUniswapV3Pool.sol";
import {OutcomeResolver} from "src/libraries/OutcomeResolver.sol";
import {FeeArenaV2Settlement} from "src/FeeArenaV2Settlement.sol";
import {FeeArenaV2Staking} from "src/FeeArenaV2Staking.sol";
// File-level storage rows shared with the settlement/staking libraries (so they can take `storage`
// refs to them); imported bare so the contract body reads `EpochV2`/`Position`/`StakeStaging` as before.
import {EpochV2, Position, StakeStaging, Globals} from "src/FeeArenaV2Types.sol";

// IERC20Decimals: minimal decimals() reader (USDC/WETH boot asserts).
interface IERC20DecimalsV2 {
    function decimals() external view returns (uint8);
}

/// @title FeeArenaV2 - conviction-parimutuel + bounded subsidy, BURN-on-loss.
/// @notice v2 economic redesign of {FeeArena}. Built as a NEW contract (v1 stays
///         immutable + its tests intact) reusing v1's proven patterns: the 6-phase
///         machine, pull-claim with `Position.claimed`, the paginated try/catch sweep,
///         `foldDust`, `emergencySettle`, and a COUNTER-based solvency invariant.
///
///         Economic core (NON-NEGOTIABLE, docs/spec-feearena-v2.md §FINALMECHANISM):
///         conviction posted at stake (bounded [minConv,maxConv]); POT = forfeited fees
///         + bounded subsidy R ONLY; losing-side conviction is BURNED to TREASURY (never
///         recycled); winning-side conviction refunded 1:1 (decoupled from the pot claim);
///         pot split sqrt(conviction)-weighted, gated on contribution6>0 (real in-range LP);
///         R hard-capped (distributable pot <= 2*winningConvictionSum) + dust-gated
///         (2*minConv > R). O(1) solvency incl. live conviction + committed subsidy;
///         blocklist-resilient pull payouts; pinned settle price + Pyth conf bound; a
///         timelocked oracle-migration path.
///
///         Implemented across tasks: T1 state + STAKE/CONVICTION flow; T2 settle/sweep/finalize/
///         claim/refund/subsidy + the economic core; Task 3 HARDENING - pinned-settle endpoints
///         (T1 via getPinnedPrice -> parsePriceFeedUpdates, symmetric [min,max] windows capped at
///         60s), the Pyth confidence bound (T2), the O(1) counter-based solvency (C2), and the
///         narrow 48h-timelocked oracle migration (C4) paired with an emergencySettle that refunds
///         conviction 1:1 to ALL stakers on a genuinely-unresolved epoch.
contract FeeArenaV2 is IFeeArena, Ownable, Pausable, ReentrancyGuard {
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

    /// @notice Hard cap on the settle-price pin window (spec §HARDENING T1). The
    ///         owner-set `settleWindow` may never exceed this; NEVER maxPriceAge=600s.
    uint32 public constant MAX_SETTLE_WINDOW = 60;

    /// @notice Mandatory timelock before a proposed oracle migration can execute
    ///         (spec §HARDENING C4). Filled in T2; declared here for the surface.
    uint64 public constant ORACLE_TIMELOCK = 48 hours;

    // ---- core immutables ----
    address public immutable USDC;
    address public immutable WETH;
    address public immutable POOL;
    address public immutable NPM;
    address public immutable FACTORY;
    uint24 public immutable FEE_TIER;
    uint128 public immutable MIN_LIQUIDITY;
    uint256 public immutable WETH_NOTIONAL_DIV;
    uint8 public immutable wethIsToken0;

    /// @notice Burn sink for losing-side conviction (spec §STATECHANGES). Losing
    ///         conviction is transferred OUT here at finalizeSettle and NEVER enters
    ///         potUSDC. Immutable, ZeroAddress-checked at boot.
    address public immutable TREASURY;

    /// @notice The price oracle. MUTABLE (not immutable as in v1) so the narrow,
    ///         48h-timelocked migration path (C4) can replace it without redeploy.
    ///         Swapped only by `executeOracleMigration`; set once at boot.
    address public oracle;

    /// @notice C4 timelocked oracle migration: the proposed next oracle + its earliest
    ///         execute time (now + ORACLE_TIMELOCK). pendingOracle==0 => no migration in
    ///         flight. Cleared on execute. No instant swap (v1's defect).
    address public pendingOracle;
    uint64 public oracleUnlockTime;

    // ---- mutable timing/band config (snapshotted into Epoch at create) ----
    uint32 public entryWindow;
    uint32 public epochDuration;
    uint32 public minStartGap;
    uint32 public maxStartDelay;
    uint32 public maxPriceAge;
    int32 public bandBps;
    uint32 public maxStakesPerEpoch;
    uint32 public maxStakesPerUser;

    // ---- v2 conviction/oracle config (future-epoch-only setters) ----

    /// @notice Conviction bounds (USDC 6-dp). Invariant: minConv>0, maxConv>=minConv,
    ///         maxConv<=10*minConv recommended. `2*minConv > maxSubsidyPerEpoch` keeps
    ///         even the cheapest 2-leg burn larger than the per-epoch subsidy (dust-gate).
    uint256 public minConv;
    uint256 public maxConv;

    /// @notice T1 pin width: settle/start price publishTime is forced into
    ///         [endpointTime, endpointTime+settleWindow]. Default ~12s, hard cap
    ///         MAX_SETTLE_WINDOW(60s). Owner-settable, future-epoch-only.
    uint32 public settleWindow;

    /// @notice T2 confidence bound (bps). Accepted iff conf*BPS <= price*maxConfBps.
    ///         MUST be << bandBps so band decisions are never inside oracle noise.
    uint32 public maxConfBps;

    /// @notice Per-epoch hard cap on committed subsidy R (spec §SUBSIDYFLOW). The owner
    ///         can never `fundSubsidy` an epoch past this. Dust-gate: < 2*minConv.
    uint256 public maxSubsidyPerEpoch;

    // ---- epoch + position storage ----
    //
    // The canonical {EpochV2} / {Position} rows are declared in {FeeArenaV2Settlement} so the
    // external settlement library can take `storage` references to them (the heavy settle/finalize/
    // sweep/claim/refund/foldDust math is deployed there for EIP-170). The storage LAYOUT is
    // unchanged from the prior in-contract definitions. They are aliased here as `EpochV2`/`Position`
    // (via the `using` import) so the rest of this contract - and `FeeArenaV2Settlement.EpochV2` in
    // external callers/tests - reads identically.

    mapping(uint64 => EpochV2) internal epochs;

    mapping(uint256 => Position) public positions;
    mapping(uint64 => uint256[]) internal epochTokenIds;
    mapping(address => mapping(uint64 => uint256[])) public userEpochTokenIds;
    mapping(address => uint256) public lastStakeBlock;

    uint64 public currentEpochId;
    uint64 public lastSettledEpochId;

    /// @notice Staked positions on the winning side WITH contribution6 > 0 (gates foldDust).
    mapping(uint64 => uint32) public winnerCount;

    // ---- v2 O(1) GLOBAL AGGREGATE COUNTERS (REPLACE the v1 settledEpochIds loop, C2) ----
    //
    // Bundled into ONE {Globals} storage var `g` so the settlement library can take a
    // `Globals storage` ref and update the counters DIRECTLY (no delta-return structs / ABI-decode
    // glue - the EIP-170 win). Each counter is re-exposed below via a same-named public getter so
    // the external/test surface (`arena.totalOwedWETH()`, etc.) is byte-for-byte unchanged.
    //   rolloverWETH/USDC                - pending carry-forward pot (empty-winner / R-cap excess / dust).
    //   totalOwedWETH/USDC               - owed over open settled epochs (incl. winning conviction, USDC).
    //   totalCustodiedConviction         - live conviction of not-yet-finalized epochs.
    //   totalCommittedSubsidy            - committed-but-not-finalized R.
    //   totalLedgerUSDC/WETH             - O(1) aggregate of the C3 deferred-payout credit ledgers.
    Globals internal g;

    function rolloverWETH() external view returns (uint256) {
        return g.rolloverWETH;
    }

    function rolloverUSDC() external view returns (uint256) {
        return g.rolloverUSDC;
    }

    function totalOwedWETH() external view returns (uint256) {
        return g.totalOwedWETH;
    }

    function totalOwedUSDC() external view returns (uint256) {
        return g.totalOwedUSDC;
    }

    function totalCustodiedConviction() external view returns (uint256) {
        return g.totalCustodiedConviction;
    }

    function totalCommittedSubsidy() external view returns (uint256) {
        return g.totalCommittedSubsidy;
    }

    function totalLedgerUSDC() external view returns (uint256) {
        return g.totalLedgerUSDC;
    }

    function totalLedgerWETH() external view returns (uint256) {
        return g.totalLedgerWETH;
    }

    /// @notice C3 blocklist-resilient credit ledgers. A failed USDC/WETH send credits the
    ///         recipient here (claim/refund counters STILL bump so foldDust can't brick);
    ///         the recipient later pulls via withdrawCredited to a clean address.
    mapping(address => uint256) public owedUSDC;
    mapping(address => uint256) public owedWETH;

    /// @notice Least-privilege keeper allowed to run the epoch LIFECYCLE
    ///         (createEpoch + openEntry) ONLY. Owner-set/cleared. Conviction stakers
    ///         must NOT be the keeper or owner (operator-exclusion, spec §STAKEFLOW).
    address public keeper;

    // ---- v2 transient stake staging (stakeWithConviction -> onERC721Received) ----
    // (the StakeStaging row is declared file-level in FeeArenaV2Types.sol so the staking library
    // can take a `storage` ref to this mapping for the moved recorder body.)

    mapping(uint256 => StakeStaging) internal stakeStaging;

    // ---- v2 errors (v1 errors come from IFeeArena) ----
    error ConvOutOfBounds();
    error MissingConviction();
    error StagedSideMismatch();
    error OperatorCannotStake();
    error SideOverConcentrated();
    error ConvBoundsInvalid();
    error SettleWindowTooLarge();
    error ConfBpsInvalid();
    error SubsidyCapInvalid();
    error ZeroStakeCap();
    error WrongEpoch();
    error NotRefundable();
    error AlreadyRefunded();
    error SubsidyCapExceeded();
    error NothingCredited();
    // T2 conf bound + C4 oracle-migration + emergencySettle (Task 3 hardening).
    error WideConfidence();
    error NoPendingOracle();
    error TimelockNotElapsed();
    error EpochInFlight();
    error OracleSanityFailed();
    error EpochResolvable();

    // ---- v2 events ----
    event ConvictionStaked(
        uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, Side side, uint256 conviction
    );
    event ConvBoundsUpdated(uint256 minConv, uint256 maxConv);
    event SettleWindowUpdated(uint32 settleWindow);
    event MaxConfBpsUpdated(uint32 maxConfBps);
    event MaxSubsidyPerEpochUpdated(uint256 maxSubsidyPerEpoch);
    event PayoutDeferred(address indexed to, uint256 usdcAmt, uint256 wethAmt);

    // v2-ONLY settle/claim/refund/subsidy events (the v1 lifecycle/settle events -
    // EpochStarted/EpochResolved/Swept/EpochSettled/Claimed/DustFolded/RolloverInjected/
    // EmptyWinnerRollover/SweepProgressed/SweepFailed/EpochSwept/EmergencySettled - are
    // inherited from IFeeArena and emitted directly).
    event SubsidyCapped(uint64 indexed epochId, uint256 distributablePot, uint256 rolledExcess);
    event ConvictionBurned(uint64 indexed epochId, uint256 burnedConviction);
    event ConvictionRefunded(uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, uint256 amount);
    event SubsidyFunded(uint64 indexed epochId, uint256 amount, uint256 totalSubsidy);
    event CreditWithdrawn(address indexed to, uint256 usdcAmt, uint256 wethAmt);
    // Task 3 hardening: pinned-settle endpoints (T1/T2) + C4 timelocked oracle migration.
    event PricePinned(uint64 indexed epochId, bool isStart, uint256 price18, uint256 conf18, uint64 publishTime);
    event OracleProposed(address indexed newOracle, uint64 unlockTime);
    event OracleMigrated(address indexed oldOracle, address indexed newOracle);
    event EmergencyConvictionRefunded(
        uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, uint256 amount
    );

    /// @dev Extended boot config: v1 BootConfig fields + v2 conviction/oracle/treasury.
    ///      A struct param keeps the constructor stack shallow (via-ir disabled in the
    ///      mixed-solc workspace).
    struct BootConfigV2 {
        // ---- v1 fields (mirror IFeeArena.BootConfig) ----
        address usdc;
        address weth;
        address pool;
        address npm;
        address factory;
        address oracle;
        address owner;
        uint24 feeTier;
        uint128 minLiquidity;
        uint32 entryWindow;
        uint32 epochDuration;
        uint32 minStartGap;
        uint32 maxStartDelay;
        uint32 maxPriceAge;
        int32 bandBps;
        // ---- v2 additions ----
        address treasury;
        uint256 minConv;
        uint256 maxConv;
        uint32 settleWindow;
        uint32 maxConfBps;
        uint32 maxStakesPerEpoch; // NON-ZERO default (bounds the sweep)
        uint256 maxSubsidyPerEpoch;
    }

    constructor(BootConfigV2 memory c) Ownable() {
        WETH_NOTIONAL_DIV = _bootValidate(c);

        (USDC, WETH, POOL, NPM, FACTORY) = (c.usdc, c.weth, c.pool, c.npm, c.factory);
        oracle = c.oracle;
        TREASURY = c.treasury;
        FEE_TIER = uint24(c.feeTier);
        MIN_LIQUIDITY = c.minLiquidity;
        wethIsToken0 = IUniswapV3Pool(c.pool).token0() == c.weth ? 1 : 0;

        _initTiming(c);
        _initConvictionConfig(c);
        _transferOwnership(c.owner);
    }

    /// @dev Boot asserts + derived WETH_NOTIONAL_DIV. Mirrors v1 plus the v2 TREASURY
    ///      ZeroAddress check and the conviction/subsidy/window invariants.
    function _bootValidate(BootConfigV2 memory c) private view returns (uint256 notionalDiv) {
        if (
            c.usdc == address(0) || c.weth == address(0) || c.pool == address(0) || c.npm == address(0)
                || c.factory == address(0) || c.oracle == address(0) || c.owner == address(0)
                || c.treasury == address(0)
        ) revert ZeroAddress();

        uint8 ud = IERC20DecimalsV2(c.usdc).decimals();
        uint8 wd = IERC20DecimalsV2(c.weth).decimals();
        // USDC must be 6-dp (Arc native). The non-USDC leg may have any decimals.
        if (ud != 6) revert BadDecimals();
        if (INonfungiblePositionManager(c.npm).factory() != c.factory) revert NotPool();
        if (c.bandBps <= 0 || c.bandBps >= int32(int256(BPS))) revert BandOutOfRange();

        // v2 conviction bounds: minConv>0, maxConv>=minConv.
        if (c.minConv == 0 || c.maxConv < c.minConv) revert ConvBoundsInvalid();
        // T1 pin window: 0 < settleWindow <= MAX_SETTLE_WINDOW.
        if (c.settleWindow == 0 || c.settleWindow > MAX_SETTLE_WINDOW) revert SettleWindowTooLarge();
        // T2 conf bound: nonzero and strictly inside the band so a band decision is never
        // made inside oracle noise.
        if (c.maxConfBps == 0 || int32(int256(uint256(c.maxConfBps))) >= c.bandBps) revert ConfBpsInvalid();
        // dust-gate: per-epoch subsidy cap strictly below the cheapest 2-leg burn (2*minConv).
        if (c.maxSubsidyPerEpoch >= 2 * c.minConv) revert SubsidyCapInvalid();
        // sweep must be bounded: maxStakesPerEpoch is non-zero in v2.
        if (c.maxStakesPerEpoch == 0) revert ZeroStakeCap();

        notionalDiv = 10 ** (uint256(wd) + uint256(PRICE_DECIMALS) - uint256(ud));
    }

    function _initTiming(BootConfigV2 memory c) private {
        entryWindow = c.entryWindow;
        epochDuration = c.epochDuration;
        minStartGap = c.minStartGap;
        maxStartDelay = c.maxStartDelay;
        maxPriceAge = c.maxPriceAge;
        bandBps = c.bandBps;
        maxStakesPerEpoch = c.maxStakesPerEpoch;
    }

    function _initConvictionConfig(BootConfigV2 memory c) private {
        minConv = c.minConv;
        maxConv = c.maxConv;
        settleWindow = c.settleWindow;
        maxConfBps = c.maxConfBps;
        maxSubsidyPerEpoch = c.maxSubsidyPerEpoch;
    }

    // ---- keeper role (least-privilege lifecycle driver) ----

    function setKeeper(address newKeeper) external onlyOwner {
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

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
        // maxConfBps must stay strictly inside the (possibly lowered) band.
        if (int32(int256(uint256(maxConfBps))) >= bandBps_) revert ConfBpsInvalid();
        bandBps = bandBps_;
        emit BandUpdated(bandBps_);
    }

    /// @notice maxStakesPerEpoch in v2 is bounded (non-zero); 0==unlimited is removed.
    function setStakeCaps(uint32 maxStakesPerEpoch_, uint32 maxStakesPerUser_) external onlyOwner {
        if (maxStakesPerEpoch_ == 0) revert ZeroStakeCap();
        maxStakesPerEpoch = maxStakesPerEpoch_;
        maxStakesPerUser = maxStakesPerUser_;
        emit StakeCapsUpdated(maxStakesPerEpoch_, maxStakesPerUser_);
    }

    /// @notice Update conviction bounds (future-epoch-only). minConv>0, maxConv>=minConv,
    ///         and the dust-gate `2*minConv > maxSubsidyPerEpoch` must continue to hold.
    function setConvBounds(uint256 minConv_, uint256 maxConv_) external onlyOwner {
        if (minConv_ == 0 || maxConv_ < minConv_) revert ConvBoundsInvalid();
        if (maxSubsidyPerEpoch >= 2 * minConv_) revert SubsidyCapInvalid();
        minConv = minConv_;
        maxConv = maxConv_;
        emit ConvBoundsUpdated(minConv_, maxConv_);
    }

    /// @notice Update the T1 pin window (future-epoch-only). 0 < settleWindow <= 60s.
    function setSettleWindow(uint32 settleWindow_) external onlyOwner {
        if (settleWindow_ == 0 || settleWindow_ > MAX_SETTLE_WINDOW) revert SettleWindowTooLarge();
        settleWindow = settleWindow_;
        emit SettleWindowUpdated(settleWindow_);
    }

    /// @notice Update the T2 conf bound (future-epoch-only). 0 < maxConfBps < bandBps.
    function setMaxConfBps(uint32 maxConfBps_) external onlyOwner {
        if (maxConfBps_ == 0 || int32(int256(uint256(maxConfBps_))) >= bandBps) revert ConfBpsInvalid();
        maxConfBps = maxConfBps_;
        emit MaxConfBpsUpdated(maxConfBps_);
    }

    /// @notice Update the per-epoch subsidy cap (future-epoch-only). dust-gate: < 2*minConv.
    function setMaxSubsidyPerEpoch(uint256 maxSubsidyPerEpoch_) external onlyOwner {
        if (maxSubsidyPerEpoch_ >= 2 * minConv) revert SubsidyCapInvalid();
        maxSubsidyPerEpoch = maxSubsidyPerEpoch_;
        emit MaxSubsidyPerEpochUpdated(maxSubsidyPerEpoch_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---- lifecycle cranks ----

    function createEpoch() external onlyOwnerOrKeeper returns (uint64 epochId) {
        if (currentEpochId != 0) {
            if (epochs[currentEpochId].phase != Phase.Settled) revert PrevNotSettled();
        }

        epochId = currentEpochId + 1;
        uint64 nowTs = uint64(block.timestamp);
        uint64 entryOpen = nowTs;
        uint64 entryClose = entryOpen + entryWindow;
        uint64 start = entryClose + minStartGap;
        uint64 end = start + epochDuration;

        if (!(entryClose < start && start < end)) revert BadTimes();
        int32 band = bandBps;
        if (band <= 0 || band >= int32(int256(BPS))) revert BandOutOfRange();

        EpochV2 storage e = epochs[epochId];
        e.phase = Phase.None;
        e.entryOpenTime = entryOpen;
        e.entryCloseTime = entryClose;
        e.startTime = start;
        e.endTime = end;
        e.bandBps = band;

        currentEpochId = epochId;
        emit EpochCreated(epochId, entryOpen, entryClose, start, end, band);
    }

    function openEntry() external onlyOwnerOrKeeper {
        EpochV2 storage e = epochs[currentEpochId];
        if (e.phase != Phase.None) revert WrongPhase();
        e.phase = Phase.EntryOpen;
    }

    // ---- staking (Group K v2): conviction-collected stake ----

    /// @notice v2 stake entrypoint. Pulls USDC conviction FIRST (effects-friendly), stages
    ///         it keyed by tokenId, then pushes the NFT which converges on the guarded
    ///         `onERC721Received` recorder. There is NO no-conviction stake in v2.
    ///
    ///         Flow (spec §STAKEFLOW):
    ///           1. bounds-check minConv <= conviction <= maxConv.
    ///           2. operator-exclusion: msg.sender != keeper && != owner().
    ///           3. pull conviction via safeTransferFrom BEFORE the NFT.
    ///           4. stage (msg.sender, side, conviction) keyed by tokenId.
    ///           5. NPM.safeTransferFrom(...) -> onERC721Received (records the position).
    /// @dev NOT `nonReentrant`: this entrypoint INTENTIONALLY triggers the NFT push that
    ///      converges on `onERC721Received`, which IS `nonReentrant` (the single guarded
    ///      recorder - mirrors v1's `stakeWithSide` discipline). The USDC conviction pull
    ///      runs first against the canonical Arc native USDC (a trusted token); the staging
    ///      record is keyed by tokenId and cleared inside the guarded recorder.
    function stakeWithConviction(uint256 tokenId, Side side, uint256 conviction) external whenNotPaused {
        // Step 1: conviction bounds.
        if (conviction < minConv || conviction > maxConv) revert ConvOutOfBounds();
        // Step 2: side sanity (reject NONE / out-of-range up front; the hook re-checks).
        if (side < Side.UP || side > Side.RANGE) revert BadSide();
        // Step 3: operator-exclusion - the party that can settle must not hold conviction.
        if (msg.sender == keeper || msg.sender == owner()) revert OperatorCannotStake();

        // Step 4: pull conviction BEFORE the NFT (custodied; recorded in the hook).
        IERC20(USDC).safeTransferFrom(msg.sender, address(this), conviction);
        g.totalCustodiedConviction += conviction;

        // Step 5: stage keyed by tokenId for the converging onERC721Received recorder.
        stakeStaging[tokenId] = StakeStaging({staker: msg.sender, side: side, conviction: conviction, pending: true});

        // Step 6: push the NFT -> converges on the guarded recorder; clears the staging.
        INonfungiblePositionManager(NPM).safeTransferFrom(msg.sender, address(this), tokenId, abi.encode(side));
    }

    /// @notice ERC721 receiver hook = the single guarded stake recorder. Preserves ALL v1
    ///         Steps 1-7 (NPM-only, side decode/validate, window guard, same-block guard,
    ///         one-side-per-epoch, caps, pool validation, the §3.1-step-7 collect-zeroing)
    ///         and ADDITIONALLY binds the staged conviction (v2 §STAKEFLOW step 4-6).
    ///         In v2 a direct NFT transfer with NO staged conviction reverts MissingConviction.
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
        // Step 1: only genuine V3 positions from the configured NPM (kept on the entrypoint with
        // the nonReentrant/whenNotPaused guard). The rest of the recorder runs in a private
        // sub-frame (_receiveStake) so the legacy (non-via-ir) stack stays in bounds.
        if (msg.sender != NPM) revert NotNPM();
        _receiveStake(from, tokenId, data);
        return ERC721_RECEIVED;
    }

    /// @dev The post-NPM-check body of onERC721Received in its own stack frame. Steps 2-6 (decode/
    ///      bind, guards, caps, pool validation) are delegated to {FeeArenaV2Staking.checkAndValidate}
    ///      (EIP-170 extraction); the arena keeps the cheap Step 7 collect + Steps 8-9 record/emit.
    function _receiveStake(address from, uint256 tokenId, bytes calldata data) private {
        EpochV2 storage ep = epochs[currentEpochId];
        FeeArenaV2Staking.Validated memory v = FeeArenaV2Staking.checkAndValidate(
            ep,
            positions,
            userEpochTokenIds,
            lastStakeBlock,
            stakeStaging,
            from,
            tokenId,
            data,
            FeeArenaV2Staking.Cfg({
                npm: NPM,
                factory: FACTORY,
                pool: POOL,
                feeTier: FEE_TIER,
                minLiquidity: MIN_LIQUIDITY,
                maxStakesPerUser: maxStakesPerUser,
                maxStakesPerEpoch: maxStakesPerEpoch,
                currentEpochId: currentEpochId
            })
        );

        // Step 7 (fairness): zero pre-existing fees to the LP so only [stake,end] fees count.
        INonfungiblePositionManager(NPM)
            .collect(
                INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: from, amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
            );

        // Steps 8-9: record + counters + conviction + events, clear staging.
        _recordStake(ep, from, tokenId, v.side, v.liq, v.span, v.conviction);
        delete stakeStaging[tokenId];
    }

    /// @dev Record the staked position + its custodied conviction (Steps 8-9). Kept in the arena
    ///      (cheap storage writes + both events); the heavy validation moved to {FeeArenaV2Staking}.
    function _recordStake(
        EpochV2 storage ep,
        address from,
        uint256 tokenId,
        Side side,
        uint128 liquidity,
        uint32 tickSpan,
        uint256 conviction
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
            tickSpan: tickSpan,
            conviction: conviction,
            convictionRefunded: false
        });
        epochTokenIds[currentEpochId].push(tokenId);
        userEpochTokenIds[from][currentEpochId].push(tokenId);
        lastStakeBlock[from] = block.number;
        ep.stakedCount += 1;
        ep.sideConviction[uint256(uint8(side))] += conviction;
        emit Staked(currentEpochId, from, tokenId, side, ep.stakedCount);
        emit ConvictionStaked(currentEpochId, from, tokenId, side, conviction);
    }

    /// @notice Return an escrowed NFT to its owner once the epoch is fully Settled and the
    ///         position swept (mirrors v1). Reward + conviction principal are the separate
    ///         claim() / refundConviction() pull paths - NOT auto-returned here.
    function unstake(uint256 tokenId) external nonReentrant {
        Position storage p = positions[tokenId];
        if (p.owner != msg.sender || p.unstaked) revert NotOwner();

        EpochV2 storage ep = epochs[p.epochId];
        if (ep.phase != Phase.Settled) revert NotSettled();
        if (!p.swept) revert NotSwept();

        p.unstaked = true;
        emit Unstaked(p.epochId, p.owner, tokenId);

        INonfungiblePositionManager(NPM).safeTransferFrom(address(this), p.owner, tokenId);
    }

    // ---- staking views ----
    //
    // The heavy read/preview projections (getStake / getStakesByEpoch / previewClaim /
    // previewRefund + the StakeView/ClaimPreview builder logic) live in the SEPARATE
    // stateless {FeeArenaV2Lens} (constructed with this arena's address) so their
    // bytecode leaves the main contract (EIP-170). The Lens reads this arena's public
    // surface: the auto-generated `positions` getter, `getEpoch`, and `epochTokenIdsAt`.

    /// @notice Conviction view for a position (UI / accounting).
    function getConviction(uint256 tokenId) external view returns (uint256 conviction, bool refunded) {
        Position storage p = positions[tokenId];
        return (p.conviction, p.convictionRefunded);
    }

    /// @notice Full Position row as a single memory struct (cheap storage->memory copy, no
    ///         computation). {FeeArenaV2Lens} reads THIS instead of the 13-field `positions`
    ///         auto-getter so it does not have to destructure a 13-tuple (which overflows the
    ///         legacy non-via-ir stack). The Lens builds StakeView/ClaimPreview projections from it.
    function getPosition(uint256 tokenId) external view returns (Position memory) {
        return positions[tokenId];
    }

    /// @notice Number of staked positions recorded for an epoch (Lens pagination over
    ///         `epochTokenIdsAt`). The `epochTokenIds` list itself is internal.
    function epochStakeCount(uint64 epochId) external view returns (uint256) {
        return epochTokenIds[epochId].length;
    }

    /// @notice The i-th staked tokenId of an epoch (cheap targeted getter for {FeeArenaV2Lens},
    ///         far smaller than returning the whole array). Reverts on out-of-range index.
    function epochTokenIdsAt(uint64 epochId, uint256 index) external view returns (uint256) {
        return epochTokenIds[epochId][index];
    }

    // =====================================================================
    // SUBSIDY - committed, accounted, irreversible (spec §SUBSIDYFLOW)
    // =====================================================================

    /// @notice Commit external subsidy R irreversibly into an epoch's potUSDC. Owner-only,
    ///         phase < Resolved (so band-winners cannot be chosen AFTER R is known - no
    ///         settlement-timing game), hard-capped at `maxSubsidyPerEpoch` (which is itself
    ///         dust-gated < 2*minConv at config time). R is now part of the accounted pot and
    ///         has NO withdraw path; if the epoch empty-winners it rolls forward via the pot.
    ///         Solvency counts R via `totalCommittedSubsidy` until finalize folds it into
    ///         `totalOwedUSDC`.
    function fundSubsidy(uint64 epochId, uint256 amount) external onlyOwner nonReentrant whenNotPaused {
        EpochV2 storage e = epochs[epochId];
        // Phase < Resolved: None/EntryOpen/Running only (commit BEFORE the outcome exists).
        if (!(e.phase == Phase.None || e.phase == Phase.EntryOpen || e.phase == Phase.Running)) revert WrongPhase();
        if (amount == 0) revert SubsidyCapExceeded();
        // HARD CAP: per-epoch committed R can never exceed maxSubsidyPerEpoch.
        if (amount + e.subsidyUSDC > maxSubsidyPerEpoch) revert SubsidyCapExceeded();

        // EFFECTS: R becomes part of the accounted pot; counted by solvency until finalize.
        e.subsidyUSDC += amount;
        e.potUSDC += amount;
        g.totalCommittedSubsidy += amount;

        // INTERACTION: pull the owner's USDC LAST.
        IERC20(USDC).safeTransferFrom(msg.sender, address(this), amount);
        emit SubsidyFunded(epochId, amount, e.subsidyUSDC);
        _assertSolvent();
    }

    // =====================================================================
    // SETTLE - start / end with PINNED oracle (spec §HARDENING T1+T2),
    //          applied SYMMETRICALLY to BOTH endpoints (RANGE delta depends on
    //          both prices, so loosening either moves the exploit). The CONTRACT
    //          fixes the publishTime window via getPinnedPrice -> parsePriceFeedUpdates
    //          (cranker can no longer select the print), then bounds Pyth confidence.
    // =====================================================================

    /// @notice Capture the epoch start price (EntryOpen -> Running) via the PINNED oracle read.
    ///         T1: publishTime is forced into [startTime, startTime+settleWindow] (settleWindow
    ///         hard-capped at 60s) by getPinnedPrice -> parsePriceFeedUpdates, so the cranker
    ///         cannot pick a favorable print. T2: the returned conf must satisfy
    ///         conf*BPS <= price*maxConfBps. Reads through the mutable `oracle` slot (C4-ready).
    function startEpoch(bytes[] calldata priceData) external payable nonReentrant whenNotPaused {
        uint256 balBefore = address(this).balance - msg.value;
        EpochV2 storage e = epochs[currentEpochId];
        if (e.phase != Phase.EntryOpen) revert WrongPhase();
        if (block.timestamp < e.entryCloseTime) revert StartTooEarly();
        if (block.timestamp > uint256(e.entryCloseTime) + maxStartDelay) revert StartDelayExceeded();

        // T1: pin window [startTime, startTime+settleWindow]. T2: bound conf.
        uint256 price18 = _pinnedFetch(currentEpochId, true, priceData, e.startTime);

        e.startPrice18 = price18;
        e.startTimeActual = uint64(block.timestamp);
        e.phase = Phase.Running;
        emit EpochStarted(currentEpochId, price18, e.startTimeActual);
        _refundExcess(balBefore);
    }

    /// @notice Capture the settle price + resolve the winning Side (Running -> Resolved) via the
    ///         PINNED oracle read. Symmetric to startEpoch: T1 pins publishTime to
    ///         [endTime, endTime+settleWindow]; T2 bounds conf. OutcomeResolver.resolve is
    ///         unchanged (single-sourced - the entire fix is at the price-INPUT boundary).
    function endEpoch(bytes[] calldata priceData) external payable nonReentrant whenNotPaused {
        uint256 balBefore = address(this).balance - msg.value;
        EpochV2 storage e = epochs[currentEpochId];
        if (e.phase != Phase.Running) revert WrongPhase();
        if (block.timestamp < e.endTime) revert EpochNotEnded();

        // T1: pin window [endTime, endTime+settleWindow]. T2: bound conf.
        uint256 price18 = _pinnedFetch(currentEpochId, false, priceData, e.endTime);

        e.settlePrice18 = price18;
        e.settleTimeActual = uint64(block.timestamp);

        (Side winner, int256 delta) = OutcomeResolver.resolve(e.startPrice18, price18, e.bandBps);
        e.winningSide = winner;
        e.deltaBps = delta;
        e.phase = Phase.Resolved;

        emit EpochResolved(currentEpochId, price18, winner, delta, e.settleTimeActual);
        _refundExcess(balBefore);
    }

    /// @dev The shared pinned-price fetch for BOTH endpoints (spec §HARDENING T1+T2). Forwards
    ///      the WHOLE msg.value as the parse fee (excess refunded by the oracle, then any net
    ///      excess refunded to msg.sender by _refundExcess in the caller). The window is
    ///      [endpointTime, endpointTime+settleWindow]; settleWindow is hard-capped <= 60s at the
    ///      config setters, so the cranker's WHEN-to-crank optionality is bounded to that window.
    ///      Reverts: ZeroPrice (price<=0) via oracle; WideConfidence if conf*BPS > price*maxConfBps.
    ///      Isolated as a helper so each crank's stack stays within the legacy-pipeline limit.
    function _pinnedFetch(uint64 epochId, bool isStart, bytes[] calldata priceData, uint64 endpointTime)
        private
        returns (uint256 price18)
    {
        uint64 minPub = endpointTime;
        uint64 maxPub = endpointTime + settleWindow;
        (uint256 p18, uint256 conf18, uint64 publishTime) =
            IPinnedPriceOracle(oracle).getPinnedPrice{value: msg.value}(priceData, minPub, maxPub);
        // Belt-and-suspenders staleness on the PINNED publishTime (maxPriceAge is NOT the binding
        // bound - the [min,max] window is - but a stale pin still fails fast). Also rejects p18==0.
        _requireFresh(p18, publishTime);
        // T2 conf bound: conf*BPS <= price*maxConfBps. maxConfBps is enforced < bandBps at the
        // config setters, so a band decision is NEVER made inside oracle noise.
        if (conf18 * BPS > p18 * uint256(maxConfBps)) revert WideConfidence();
        emit PricePinned(epochId, isStart, p18, conf18, publishTime);
        return p18;
    }

    // =====================================================================
    // SWEEP - paginated try/catch collect, folding the winner + sqrt-conviction
    //         tally INTO the same pass (spec §SETTLEFLOW SWEEP).
    // =====================================================================

    /// @notice Sweep up to `maxCount` staked positions of the current (last-resolved) epoch,
    ///         collecting forfeited fees into the pot and folding the winner tally in the same
    ///         pass so finalizeSettle is O(1). Per position, when it is on the winning side:
    ///         - `winningConvictionSum += conviction` for ALL winning-side stakers (refund
    ///           accounting + R cap), regardless of contribution6 / collect outcome;
    ///         - `winnerSqrtConvSum += sqrt(conviction)` and `++winnerCount` ONLY when
    ///           contribution6 > 0 (real in-range LP) - the sqrt-weighted pot denominator.
    ///         A reverting collect is isolated (marked swept, contribution6 == 0): it gets ZERO
    ///         pot share but its conviction stays refundable (principal never forfeited by an
    ///         engine-side failure). Resumable via sweepCursor; flips Resolved -> Swept on the
    ///         final batch.
    function sweep(uint256 maxCount) external nonReentrant whenNotPaused {
        uint64 id = currentEpochId;
        EpochV2 storage e = epochs[id];
        if (e.phase == Phase.Swept || e.phase == Phase.Settled) revert SweepAlreadyDone();
        if (e.phase != Phase.Resolved) revert WrongPhase();
        if (e.settlePrice18 == 0) revert ZeroPrice();

        uint32 total = e.stakedCount;
        uint256 end = uint256(e.sweepCursor) + maxCount;
        if (end > total) end = total;

        uint256[] storage ids = epochTokenIds[id];
        for (uint256 i = e.sweepCursor; i < end; ++i) {
            // Per-position work is offloaded to a helper so the loop's live-local set stays
            // within the legacy-pipeline (non-via-ir) stack limit (mirrors v1's helper-offload).
            _sweepOne(id, e, ids[i]);
        }
        e.sweepCursor = uint32(end);
        emit SweepProgressed(id, e.sweepCursor, total);
        if (e.sweepCursor == total) {
            e.phase = Phase.Swept;
            emit EpochSwept(id, e.potWETH, e.potUSDC);
        }
        _assertSolvent();
    }

    /// @dev Sweep ONE position. The contract OWNS the try/catch isolation (it owns the NPM +
    ///      `externalCollect` self-call) and the events + winnerCount bump (CEI surface), and
    ///      delegates the per-position storage math (conviction reclassify, contribution6,
    ///      pot accrual, sqrt fold) to {FeeArenaV2Settlement.sweepOne} so that bytecode lives in
    ///      the library. Behavior is identical: the library performs the exact same writes the
    ///      inlined body did, and returns whether this position incremented the winner count.
    function _sweepOne(uint64 id, EpochV2 storage e, uint256 tokenId) private {
        Position storage p = positions[tokenId];
        if (p.swept) return; // defensive; cursor normally guarantees not-yet-swept

        try this.externalCollect(tokenId) returns (uint256 feeWeth, uint256 feeUsdc) {
            bool counted = FeeArenaV2Settlement.sweepOne(e, p, true, feeWeth, feeUsdc);
            if (counted) winnerCount[id] += 1;
            // The library stored the SafeCast-checked fees + contribution6 on `p`; emit those.
            emit Swept(id, tokenId, p.feeWETH, p.feeUSDC, p.contribution6);
        } catch {
            FeeArenaV2Settlement.sweepOne(e, p, false, 0, 0); // mark-and-skip; conviction stays refundable
            emit SweepFailed(id, tokenId);
        }
    }

    /// @notice External-self wrapper so a reverting NPM.collect is isolated by sweep's
    ///         try/catch. Returns fees ordered as (WETH-leg, USDC-leg).
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
        EpochV2 storage e = epochs[epochId];
        return (e.sweepCursor, e.stakedCount);
    }

    // =====================================================================
    // FINALIZE - O(1) (spec §SETTLEFLOW FINALIZE): R-cap, BURN losing
    //            conviction to TREASURY, freeze the sqrt denom, bump owed counters.
    // =====================================================================

    /// @notice Finalize the next-in-order Swept epoch (Swept -> Settled), O(1):
    ///         1. inject any pending rollover exactly once;
    ///         2. R-cap: if distributable pot > 2*winningConvictionSum, cap it and roll the
    ///            excess forward (excess includes committed R against thin honest conviction);
    ///         3. BURN losing-side conviction to TREASURY (blocklist-resilient), excluded from need;
    ///         4. freeze winnerDenominator = winnerSqrtConvSum (sqrt-weighted); empty/all-dust
    ///            winner rolls the whole pot forward but conviction stays refundable;
    ///         5. bump O(1) owed counters and reclassify live custodied conviction.
    function finalizeSettle() external nonReentrant whenNotPaused {
        uint64 id = lastSettledEpochId + 1;
        EpochV2 storage e = epochs[id];
        if (e.phase != Phase.Swept) revert WrongPhase();
        if (e.sweepCursor != e.stakedCount) revert SweepNotComplete();

        // EFFECTS (steps 1-5) + events + the BURN payout run in the library against this contract's
        // storage (epoch row + the {Globals} counters + the owedUSDC ledger). CEI is preserved
        // inside the library; the wrapper only sets lastSettledEpochId + asserts solvency.
        FeeArenaV2Settlement.finalizeSettle(e, g, owedUSDC, id, TREASURY);
        lastSettledEpochId = id;
        _assertSolvent();
    }

    // (the once-only rollover injection now lives inside the library's finalizeSettle/emergencySettle.)

    // =====================================================================
    // CLAIM / REFUND - decoupled (spec §CLAIMMATH). A stuck pot share must
    //                  never strand principal, and vice versa.
    // =====================================================================

    /// @notice Refund a winning-side position's conviction principal 1:1 (EXACT, no division).
    ///         Gated ONLY on (Settled && side==winner && !refunded) - NOT on winnerDenominator,
    ///         contribution6, or collect outcome, so empty-contribution winners and
    ///         collect-revert winners still reclaim their principal. Blocklist-resilient pull.
    function refundConviction(uint64 epochId, uint256 tokenId, address recipient) external nonReentrant {
        Position storage p = positions[tokenId];
        // CHECKS + EFFECTS (CEI) + the 1:1 (blocklist-resilient) refund + event run in the library
        // against this contract's storage; the wrapper only routes the recipient + asserts solvency.
        address to = recipient == address(0) ? p.owner : recipient;
        FeeArenaV2Settlement.refundConviction(epochs[epochId], p, g, owedUSDC, epochId, to, tokenId);
        _assertSolvent();
    }

    /// @notice Claim a winning position's sqrt-weighted pot share (decoupled from principal).
    ///         Gated on Settled && !rolledOver && sweep-complete && side==winner && !claimed &&
    ///         contribution6>0 (dust LP draws ZERO pot share). weight = sqrt(conviction);
    ///         payX = floor(potX * weight / winnerSqrtConvSum). Blocklist-resilient pull.
    function claim(uint64 epochId, uint256 tokenId, address recipient) external nonReentrant {
        Position storage p = positions[tokenId];
        // CHECKS + sqrt-weighted floor math + EFFECTS (CEI) + the (blocklist-resilient) mixed payout
        // + Claimed event run in the library against this contract's storage; the wrapper only
        // routes the recipient + asserts solvency.
        address to = recipient == address(0) ? p.owner : recipient;
        FeeArenaV2Settlement.claim(epochs[epochId], p, g, owedUSDC, owedWETH, epochId, tokenId, to);
        _assertSolvent();
    }

    // =====================================================================
    // FOLD DUST - residual from floor mulDiv on sqrt weights (conviction excluded).
    // =====================================================================

    /// @notice After every positive-contribution winner has claimed, roll the floor-residual
    ///         pot dust forward to the global rollover. Dust is from accounted counters, never
    ///         balanceOf. The conviction bucket is NEVER touched (refunds are exact, tracked in
    ///         `refundedConviction`, and never enter pot/claimed).
    function foldDust(uint64 epochId) external nonReentrant {
        // CHECKS + EFFECTS (CEI) + DustFolded event run in the library against this contract's
        // storage (epoch row + {Globals} counters); the wrapper only asserts solvency.
        FeeArenaV2Settlement.foldDust(epochs[epochId], g, epochId, winnerCount[epochId]);
        _assertSolvent();
    }

    // =====================================================================
    // C3 BLOCKLIST-RESILIENT PAYOUT HELPERS + withdrawCredited.
    // =====================================================================

    /// @dev Mixed (WETH+USDC) payout. Both legs are blocklist-resilient: a failed send credits
    ///      the recipient's owed* ledger instead of reverting, so the caller's EFFECTS (already
    ///      written) hold and foldDust's counters can never be bricked by a blocked winner.
    function _payout(address to, uint256 wethAmt, uint256 usdcAmt) internal {
        (uint256 lw, uint256 lu) = FeeArenaV2Settlement.payout(owedUSDC, owedWETH, to, wethAmt, usdcAmt);
        g.totalLedgerWETH += lw;
        g.totalLedgerUSDC += lu;
    }

    /// @dev Blocklist-resilient USDC send: on a failed transfer, the library credits owedUSDC[to]
    ///      + emits PayoutDeferred and returns the amount to add to the O(1) ledger aggregate. The
    ///      caller's state effects + counters are ALWAYS preserved (spec §HARDENING C3).
    function _payoutUSDC(address to, uint256 amount) internal {
        g.totalLedgerUSDC += FeeArenaV2Settlement.payoutUSDC(owedUSDC, to, amount);
    }

    /// @dev Blocklist-resilient WETH send (symmetric to _payoutUSDC). WETH has no Circle
    ///      blocklist, but the resilient path keeps a single discipline for both legs.
    function _payoutWETH(address to, uint256 amount) internal {
        g.totalLedgerWETH += FeeArenaV2Settlement.payoutWETH(owedWETH, to, amount);
    }

    /// @notice External-self transfer wrappers so a reverting/blocklisted ERC-20 transfer is
    ///         isolated by the try/catch in the payout helpers (a token whose `transfer`
    ///         returns false is caught by SafeERC20's revert).
    function externalTransferUSDC(address to, uint256 amount) external {
        require(msg.sender == address(this), "self");
        IERC20(USDC).safeTransfer(to, amount);
    }

    function externalTransferWETH(address to, uint256 amount) external {
        require(msg.sender == address(this), "self");
        IERC20(WETH).safeTransfer(to, amount);
    }

    /// @notice Pull the caller's C3-credited USDC/WETH to a clean address `to`. Lets a winner
    ///         whose owner address is blocklisted recover deferred payouts. EFFECTS first.
    function withdrawCredited(address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 u = owedUSDC[msg.sender];
        uint256 w = owedWETH[msg.sender];
        if (u == 0 && w == 0) revert NothingCredited();

        // EFFECTS FIRST (CEI): zero the ledgers + the O(1) aggregates.
        owedUSDC[msg.sender] = 0;
        owedWETH[msg.sender] = 0;
        g.totalLedgerUSDC -= u;
        g.totalLedgerWETH -= w;

        // INTERACTIONS LAST: direct sends (caller chose `to`, so it must be unblocked).
        if (w > 0) IERC20(WETH).safeTransfer(to, w);
        if (u > 0) IERC20(USDC).safeTransfer(to, u);
        emit CreditWithdrawn(to, u, w);
        _assertSolvent();
    }

    // =====================================================================
    // EMERGENCY - terminal escape hatch for a genuinely-unresolved epoch
    //   (wedged/deprecated oracle): refund conviction 1:1 to ALL stakers
    //   (both sides - no valid winner exists), roll fee pot + committed R
    //   forward, mark positions swept so NFTs are unstakeable (spec §MIGRATION 4).
    // =====================================================================

    /// @notice Owner-only terminal recovery for a wedged epoch after `endTime + GRACE`, ONLY
    ///         when the epoch never resolved (settlePrice18 == 0 - a Resolved/Swept epoch can be
    ///         driven to Settled via sweep+finalizeSettle and must never be confiscated). Since no
    ///         valid outcome exists, conviction is refunded 1:1 to ALL stakers (both sides) via the
    ///         blocklist-resilient ledger (so a deprecated/compromised feed can NEVER strand
    ///         conviction principal); the realized fee pot + committed R roll forward; positions are
    ///         marked swept so the NFTs are unstakeable. `resolution` is recorded for the event only
    ///         (the pot is rolled, never divided).
    function emergencySettle(uint64 epochId, Side resolution) external onlyOwner nonReentrant whenNotPaused {
        // CHECKS + per-position 1:1 conviction refunds (blocklist-resilient) + roll-forward EFFECTS
        // + events run in the library against this contract's storage (epoch row + {Globals}
        // counters + the owedUSDC ledger); the wrapper only sets lastSettledEpochId + asserts solvency.
        FeeArenaV2Settlement.emergencySettle(
            epochs[epochId], g, positions, epochTokenIds, owedUSDC, epochId, resolution
        );
        if (epochId == lastSettledEpochId + 1) lastSettledEpochId = epochId;
        _assertSolvent();
    }

    // =====================================================================
    // C4 - narrow, 48h-TIMELOCKED oracle migration (spec §HARDENING C4). The
    //   `oracle` slot is MUTABLE; it is swapped ONLY here, never instantly.
    // =====================================================================

    /// @notice Propose a new oracle. onlyOwner. The candidate must implement BOTH read paths and is
    ///         armed behind a mandatory ORACLE_TIMELOCK (48h). Re-proposing overwrites the pending
    ///         candidate and restarts the timelock.
    /// @dev C4: the BINDING settle read is `getPinnedPrice` (IPinnedPriceOracle), NOT `getPrice`, so
    ///      probing only `getPrice` would let a migrated oracle that DROPPED `getPinnedPrice` through.
    ///      We therefore probe BOTH:
    ///        (1) IPriceOracle.getPrice - must return >= two words (the legacy sanity probe);
    ///        (2) IPinnedPriceOracle.getPinnedPrice - a cheap zero-window probe (empty updateData,
    ///            minPub > maxPub) that a CONFORMING oracle reaches and REVERTS inside (its own
    ///            typed error / Pyth's PriceFeedNotFoundWithinRange - i.e. non-empty returndata),
    ///            whereas a candidate MISSING the selector either reverts with EMPTY returndata
    ///            (no matching function / reverting fallback) or - as a non-reverting fallback -
    ///            "succeeds" the impossible probe. Reject BOTH: a valid getPinnedPrice never
    ///            succeeds this probe, so we require `!okPin && pinRet.length > 0`.
    function proposeOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        // C4 two-probe sanity (getPrice + the BINDING getPinnedPrice) is in the staking library
        // (no arena storage needed); it reverts OracleSanityFailed on a non-conforming candidate.
        FeeArenaV2Staking.validateOracleCandidate(newOracle);

        pendingOracle = newOracle;
        oracleUnlockTime = uint64(block.timestamp) + ORACLE_TIMELOCK;
        emit OracleProposed(newOracle, oracleUnlockTime);
    }

    /// @notice Execute the pending oracle migration. onlyOwner. Requires the 48h timelock to have
    ///         elapsed AND that NO epoch is in flight: the CURRENT epoch's phase must be in
    ///         {None, EntryOpen, Settled} (never Running/Resolved/Swept) so an in-flight epoch is
    ///         never re-oracled mid-life. Swaps the mutable `oracle`, clears the pending slot.
    function executeOracleMigration() external onlyOwner {
        address next = pendingOracle;
        if (next == address(0)) revert NoPendingOracle();
        if (block.timestamp < oracleUnlockTime) revert TimelockNotElapsed();
        // No in-flight epoch: only None / EntryOpen / Settled are safe to re-oracle.
        Phase ph = epochs[currentEpochId].phase;
        if (ph == Phase.Running || ph == Phase.Resolved || ph == Phase.Swept) revert EpochInFlight();

        address old = oracle;
        oracle = next;
        pendingOracle = address(0);
        oracleUnlockTime = 0;
        emit OracleMigrated(old, next);
    }

    // =====================================================================
    // READ-SIDE VIEWS - previewClaim (sqrt) + previewRefund + epoch views.
    // =====================================================================

    function getEpoch(uint64 epochId) external view returns (EpochV2 memory) {
        return epochs[epochId];
    }

    function currentEpoch() external view returns (EpochV2 memory) {
        return epochs[currentEpochId];
    }

    // getStakesByEpoch / previewClaim / previewRefund + the StakeView/ClaimPreview builders
    // were moved to {FeeArenaV2Lens} (a stateless companion read contract) to keep this
    // contract's runtime bytecode under the EIP-170 limit. They read this arena's public
    // surface (positions getter, getEpoch, epochStakeCount/epochTokenIdsAt) and preserve the
    // exact projection math, so the frontend calls the Lens for all previews/listings.

    // ---- solvency invariant (O(1)) ----

    /// @notice O(1) solvency (spec §HARDENING C2 / §INVARIANTS S1/S2). Liabilities are
    ///         NEVER balanceOf-derived:
    ///           WETH >= totalOwedWETH + rolloverWETH + ledger(WETH);
    ///           USDC >= totalOwedUSDC + rolloverUSDC + totalCommittedSubsidy(pre-finalize)
    ///                   + totalCustodiedConviction(live) + ledger(USDC).
    ///         Burned conviction has LEFT custody (transferred to TREASURY) so it is excluded.
    function _assertSolvent() internal view {
        uint256 needWETH = g.totalOwedWETH + g.rolloverWETH + g.totalLedgerWETH;
        uint256 needUSDC =
            g.totalOwedUSDC + g.rolloverUSDC + g.totalCommittedSubsidy + g.totalCustodiedConviction + g.totalLedgerUSDC;
        require(IERC20(WETH).balanceOf(address(this)) >= needWETH, "INSOLVENT_WETH");
        require(IERC20(USDC).balanceOf(address(this)) >= needUSDC, "INSOLVENT_USDC");
    }

    // ---- internal helpers ----

    function _epoch(uint64 id) internal view returns (EpochV2 storage) {
        return epochs[id];
    }

    /// @dev Return ONLY the native that the oracle refunded for THIS crank (msg.value - fee),
    ///      never any pre-existing/donated balance. The arena holds no native between cranks.
    function _refundExcess(uint256 balBefore) internal {
        uint256 bal = address(this).balance;
        if (bal > balBefore) {
            (bool ok,) = payable(msg.sender).call{value: bal - balBefore}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _requireFresh(uint256 price18, uint256 updatedAt) internal view {
        if (price18 == 0) revert ZeroPrice();
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice();
    }

    /// @dev Accept the oracle's fee refund. No other native ETH is expected.
    receive() external payable {}
}
