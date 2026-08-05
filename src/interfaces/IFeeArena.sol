// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IFeeArena - shared types & external surface for the Fee Arena protocol.
/// @notice Declares the canonical enums/structs/errors/events plus the lifecycle
///         and view function signatures the FeeArena core implements. The `Side`
///         enum is consumed by OutcomeResolver - keep exactly ONE `Side`.
interface IFeeArena {
    // ---------------------------------------------------------------------
    // Enums
    // ---------------------------------------------------------------------

    /// @dev NONE=0 sentinel - never a valid stake or outcome.
    ///      Staked side must be UP(1)/DOWN(2)/RANGE(3).
    ///      OutcomeResolver.resolve() never returns NONE.
    enum Side {
        NONE,
        UP,
        DOWN,
        RANGE
    }

    /// @dev Internal authoritative 6-phase machine (spec §2.1). Timestamps only
    ///      justify transitions; this enum is the gate (Arc timestamps repeat).
    ///      None=0 (slot never created) → all guards reject by default.
    enum Phase {
        None,
        EntryOpen,
        Running,
        Resolved,
        Swept,
        Settled
    }

    /// @dev External (frontend) 4-phase collapse (spec §2.1 / §6.3):
    ///      None→Idle, EntryOpen→EntryOpen, Running/Resolved/Swept→Running,
    ///      Settled→Settled. Only Settled exposes claim/unstake.
    enum PhaseView {
        Idle,
        EntryOpen,
        Running,
        Settled
    }

    // ---------------------------------------------------------------------
    // Structs
    // ---------------------------------------------------------------------

    /// @dev Constructor boot config (spec §2.3 / §5.1). Passed as a single struct
    ///      because the mixed 0.7.6/0.8.20 workspace forbids via-ir, and a flat
    ///      15-arg constructor blows the legacy-pipeline stack. Every field maps
    ///      1:1 to an immutable/mutable slot; no semantics change vs a flat ctor.
    struct BootConfig {
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
    }

    /// @dev Per-epoch storage row (spec §2.4). Timing/band snapshotted at create.
    struct Epoch {
        Phase phase;
        uint64 entryOpenTime;
        uint64 entryCloseTime; // entry closes here (strictly before start)
        uint64 startTime; // epoch start; price captured at/after, bounded by maxStartDelay
        uint64 endTime; // settlement eligible threshold
        uint64 startTimeActual;
        uint64 settleTimeActual;
        Side winningSide; // valid once >= Resolved
        bool rolledOver; // empty-winner OR fully-rolled pot
        bool rolloverConsumed; // exactly-once rollover injection guard
        uint32 sweepCursor; // next staked index to sweep (0..stakedCount)
        uint32 stakedCount;
        int32 bandBps; // snapshot of band rule for THIS epoch
        uint256 startPrice18; // captured at startEpoch (>0 asserted)
        uint256 settlePrice18; // captured at endEpoch (>0 asserted)
        int256 deltaBps; // signed move, single-sourced from resolve()
        uint256 potWETH; // accounted (NEVER balanceOf) - all sides' fees + injected rollover
        uint256 potUSDC;
        uint256[4] sideContribution6; // indexed by Side (0=NONE unused); 6-dp USDC-notional
        uint256 winnerDenominator; // = sideContribution6[winningSide] at finalize; 0 => empty-winner
        uint256 claimedWETH; // running sum of paid WETH (for exact dust)
        uint256 claimedUSDC;
        uint32 claimedCount; // winners who have claimed (gates foldDust)
    }

    /// @dev Read-optimized projection of a staked Position for the UI/claim flow
    ///      (spec §3.2). Mirrors the canonical `Position` row 1:1 plus its tokenId.
    struct StakeView {
        uint256 tokenId;
        address owner;
        uint64 epochId;
        Side side;
        bool swept;
        bool claimed;
        bool unstaked;
        uint128 feeWETH;
        uint128 feeUSDC;
        uint256 contribution6;
    }

    /// @dev Read-optimized projection of an Epoch for the UI (spec §6.5). Phase is
    ///      the collapsed `PhaseView`; `rolloverPendingIn` flags an inbound carry.
    struct EpochView {
        uint64 epochId;
        PhaseView phase;
        uint64 entryOpenTime;
        uint64 entryCloseTime;
        uint64 startTime;
        uint64 endTime;
        uint64 startTimeActual;
        uint64 settleTimeActual;
        int32 bandBps;
        uint256 startPrice18;
        uint256 settlePrice18;
        int256 deltaBps;
        Side winningSide;
        bool rolledOver;
        uint32 stakedCount;
        uint32 sweepCursor;
        uint256 potWETH;
        uint256 potUSDC;
        uint256[4] sideContribution6; // per-Side 6-dp contribution snapshot (0=NONE unused)
        uint256 winnerDenominator;
        bool rolloverPendingIn; // a pending global rollover targets this epoch next
        uint256 rolloverInWETH; // pending WETH carry-in (0 unless rolloverPendingIn)
        uint256 rolloverInUSDC; // pending USDC carry-in (0 unless rolloverPendingIn)
    }

    /// @dev Read-only floor projection of a winner's claim (spec §6.5). Mirrors the
    ///      exact `claim()` math so the UI can show payouts before the on-chain pull.
    struct ClaimPreview {
        bool isWinner;
        bool alreadyClaimed;
        bool claimable;
        uint256 contribution6;
        uint256 winnerDenominator;
        uint256 payWETH;
        uint256 payUSDC;
    }

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error BadDecimals();
    error NotPool();
    error BandOutOfRange();
    error BadTimes();
    error WrongPhase();
    error PrevNotSettled();
    error NotOwnerOrKeeper();
    error StartTooEarly();
    error StartDelayExceeded();
    error EpochNotEnded();
    error ZeroPrice();
    error StalePrice();
    error StartPriceTooOld();
    error SettlePriceTooOld();
    error RefundFailed();

    // staking / escrow / unstake (Group K)
    error NotNPM();
    error BadSide();
    error BadSideData();
    error NotEntryWindow();
    error SameBlock();
    error OneSidePerEpoch();
    error CapExceeded();
    error InsufficientLiquidity();
    error NotSettled();
    error NotSwept();
    error NotOwner();

    // settlement back-half (Group M)
    error SweepAlreadyDone();
    error SweepNotComplete();
    error RolloverAlreadyConsumed();
    error WrongSide();
    error AlreadyClaimed();
    error NothingToClaim();
    error AlreadyRolledOver();
    error NotAllClaimed();
    error NothingToFold();
    error GraceNotElapsed();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event EpochCreated(
        uint64 indexed epochId,
        uint64 entryOpenTime,
        uint64 entryCloseTime,
        uint64 startTime,
        uint64 endTime,
        int32 bandBps
    );
    event EpochStarted(uint64 indexed epochId, uint256 startPrice18, uint64 startTimeActual);
    event EpochResolved(
        uint64 indexed epochId, uint256 settlePrice18, Side winningSide, int256 deltaBps, uint64 settleTimeActual
    );

    event TimingUpdated(
        uint32 entryWindow, uint32 epochDuration, uint32 minStartGap, uint32 maxStartDelay, uint32 maxPriceAge
    );
    event BandUpdated(int32 bandBps);
    event StakeCapsUpdated(uint32 maxStakesPerEpoch, uint32 maxStakesPerUser);
    event KeeperUpdated(address indexed previousKeeper, address indexed newKeeper);

    // staking / escrow / unstake (Group K)
    event Staked(uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, Side side, uint32 stakedCount);
    event Unstaked(uint64 indexed epochId, address indexed owner, uint256 indexed tokenId);

    // auto-return batch (Group M unstakeBatch; per-token success still emits Unstaked)
    event UnstakeProgressed(uint64 indexed epochId, uint32 cursor, uint32 stakedCount);
    event AutoUnstakeFailed(uint64 indexed epochId, address indexed owner, uint256 indexed tokenId);

    // settlement back-half (Group M)
    event Swept(
        uint64 indexed epochId, uint256 indexed tokenId, uint128 feeWETH, uint128 feeUSDC, uint256 contribution6
    );
    event SweepProgressed(uint64 indexed epochId, uint32 cursor, uint32 stakedCount);
    event SweepFailed(uint64 indexed epochId, uint256 indexed tokenId);
    event EpochSwept(uint64 indexed epochId, uint256 potWETH, uint256 potUSDC);
    event EpochSettled(
        uint64 indexed epochId, Side winningSide, uint256 winnerDenominator, uint256 potWETH, uint256 potUSDC
    );
    event RolloverInjected(uint64 indexed epochId, uint256 wethIn, uint256 usdcIn);
    event EmptyWinnerRollover(uint64 indexed epochId, Side winningSide, uint256 potWETH, uint256 potUSDC);
    event Claimed(
        uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, uint256 payWETH, uint256 payUSDC
    );
    event DustFolded(uint64 indexed epochId, uint256 dustWETH, uint256 dustUSDC);
    event EmergencySettled(uint64 indexed epochId, Side resolution);

    // ---------------------------------------------------------------------
    // Lifecycle & views
    // ---------------------------------------------------------------------
    // The lifecycle cranks (createEpoch/openEntry/startEpoch/endEpoch) and the
    // EpochView reads (getEpoch/currentEpoch) are implemented by the FeeArena
    // core. They are intentionally NOT declared as interface methods here so the
    // core can be built up incrementally (TDD per task) without a compile-time
    // "missing implementation" wall; callers/tests bind directly to FeeArena.
}
