// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IFeeArenaV3 - shared types & surface for the ENTRY-ANCHORED Fee Arena.
/// @notice V3 model (fee_arena_entry_anchored_btc_model.pdf): there is NO global epoch
///         start price. Every position records its OWN `entryPrice` (a fresh oracle read
///         in the stake transaction, slippage-guarded by the caller). One settlement
///         price closes the epoch; each position then resolves INDIVIDUALLY against its
///         own anchor:
///             changeBps = (finalPrice - entryPrice) * 10_000 / entryPrice
///             UP    correct iff changeBps >= +bandBps      (inclusive)
///             DOWN  correct iff changeBps <= -bandBps      (inclusive)
///             RANGE correct otherwise (strictly inside the band)
///         Winners KEEP their own epoch fees and split the LOSERS' forfeited fees
///         pro-rata by the USD notional of the fees their position produced
///         (contributionUsd6 = feeUSDC + feeBase * finalPrice, normalized to 6 dp).
interface IFeeArenaV3 {
    // ---------------------------------------------------------------------
    // Enums
    // ---------------------------------------------------------------------

    /// @dev NONE=0 sentinel - never a valid stake. Mirrors v1 ordering (UP=1/DOWN=2/RANGE=3).
    enum Side {
        NONE,
        UP,
        DOWN,
        RANGE
    }

    /// @dev Internal authoritative phase machine. The entry-anchored model needs no
    ///      "start" transition (no global start price): EntryOpen covers both the entry
    ///      window AND the locked watch period (gated by timestamps), Priced means the
    ///      settlement price landed (batch processing runs), Settled opens claims.
    enum Phase {
        None,
        EntryOpen,
        Priced,
        Settled
    }

    /// @dev External (frontend) collapse: Idle, EntryOpen (entry window live), Locked
    ///      (entry closed, watching), Settling (priced + processing), Settled.
    enum PhaseView {
        Idle,
        EntryOpen,
        Locked,
        Settling,
        Settled
    }

    // ---------------------------------------------------------------------
    // Structs
    // ---------------------------------------------------------------------

    /// @dev Constructor boot config. Single struct (mixed-solc workspace forbids via-ir;
    ///      a flat ctor blows the legacy pipeline stack). `base` is the non-USDC leg
    ///      (cirBTC). `lockDuration` = entryClose -> settlementTime watch period.
    ///      `settleSanityBps` bounds |submitted finalPrice - fresh Pyth anchor| so the
    ///      keeper's off-chain 60s average can never stray from the on-chain oracle.
    struct BootConfig {
        address usdc;
        address base;
        address pool;
        address npm;
        address factory;
        address oracle;
        address owner;
        uint24 feeTier;
        uint128 minLiquidity;
        uint32 entryWindow;
        uint32 lockDuration;
        uint32 maxPriceAge;
        int32 bandBps;
        uint32 settleSanityBps;
    }

    /// @dev Per-position record. `entryPrice18` is THE anchor (oracle read in the stake
    ///      tx). Fee fields + contribution are written at processing (post-settlement).
    struct Position {
        // slot 0 (packed exactly 32 bytes - owner 20 + epochId 8 + side/processed/won/claimed 4)
        address owner;
        uint64 epochId;
        Side side;
        bool processed;
        bool won;
        bool claimed;
        // slot 1
        bool unstaked;
        uint64 entryTime;
        uint128 entryPrice18;
        // slot 2
        uint128 feeBase;
        uint128 feeUSDC;
        // slot 3
        uint256 contributionUsd6;
    }

    /// @dev Per-epoch record. `potBase/potUSDC` hold the LOSERS' forfeited fees (+ injected
    ///      rollover); `escrowBase/escrowUSDC` hold ALL collected fees (winners' kept fees
    ///      included) for the solvency invariant; claims drain `claimed*`.
    struct Epoch {
        // slot 0
        Phase phase;
        uint64 entryOpenTime;
        uint64 entryCloseTime;
        uint64 settlementTime;
        // slot 1
        uint64 settleTimeActual;
        int32 bandBps;
        bool rolloverConsumed;
        bool rolledOver;
        uint32 stakedCount;
        uint32 processedCursor;
        uint32 winnerCount;
        uint32 claimedCount;
        // value slots
        uint256 finalPrice18;
        uint256 potBase;
        uint256 potUSDC;
        uint256 escrowBase;
        uint256 escrowUSDC;
        uint256 totalWinnerContribution;
        uint256 claimedBase;
        uint256 claimedUSDC;
    }

    /// @dev Read-side epoch projection (adds the derived PhaseView + pending rollover info).
    struct EpochView {
        uint64 epochId;
        PhaseView phase;
        uint64 entryOpenTime;
        uint64 entryCloseTime;
        uint64 settlementTime;
        uint64 settleTimeActual;
        int32 bandBps;
        bool rolledOver;
        uint32 stakedCount;
        uint32 processedCursor;
        uint32 winnerCount;
        uint32 claimedCount;
        uint256 finalPrice18;
        uint256 potBase;
        uint256 potUSDC;
        uint256 totalWinnerContribution;
        bool rolloverPendingIn;
        uint256 rolloverInBase;
        uint256 rolloverInUSDC;
    }

    /// @dev Read-side position projection (everything the UI needs to render the
    ///      per-position thresholds + result).
    struct StakeView {
        uint256 tokenId;
        address owner;
        uint64 epochId;
        Side side;
        uint64 entryTime;
        uint256 entryPrice18;
        bool processed;
        bool won;
        bool claimed;
        bool unstaked;
        uint128 feeBase;
        uint128 feeUSDC;
        uint256 contributionUsd6;
    }

    /// @dev claim() preview (UI gate - mirrors the exact on-chain claim math).
    struct ClaimPreview {
        bool claimable;
        bool isWinner;
        bool alreadyClaimed;
        int256 changeBps;
        uint256 ownFeeBase;
        uint256 ownFeeUSDC;
        uint256 potShareBase;
        uint256 potShareUSDC;
    }

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    // boot / config
    error ZeroAddress();
    error BadDecimals();
    error NotPool();
    error BandOutOfRange();
    error BadTimes();
    error NotOwnerOrKeeper();

    // oracle
    error ZeroPrice();
    error StalePrice();
    error RefundFailed();
    error SettlePriceTooOld();
    error SettlePriceOutOfBounds();

    // staking
    error NotNPM();
    error BadSide();
    error NotEntryWindow();
    error SameBlock();
    error OneSidePerEpoch();
    error CapExceeded();
    error InsufficientLiquidity();
    error EntryPriceDeviation();

    // settlement back-half
    error WrongPhase();
    error PrevNotSettled();
    error SettleTooEarly();
    error ProcessNotComplete();
    error RolloverAlreadyConsumed();
    error NotSettled();
    error NotWinner();
    error AlreadyClaimed();
    error NothingToClaim();
    error NotOwner();
    error GraceNotElapsed();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event EpochCreated(
        uint64 indexed epochId, uint64 entryOpenTime, uint64 entryCloseTime, uint64 settlementTime, int32 bandBps
    );
    event TimingUpdated(uint32 entryWindow, uint32 lockDuration, uint32 maxPriceAge);
    event BandUpdated(int32 bandBps);
    event SettleSanityUpdated(uint32 settleSanityBps);
    event StakeCapsUpdated(uint32 maxStakesPerEpoch, uint32 maxStakesPerUser);
    event KeeperUpdated(address indexed previousKeeper, address indexed newKeeper);

    /// @notice The entry anchor: every stake logs ITS OWN reference price.
    event Staked(
        uint64 indexed epochId,
        address indexed owner,
        uint256 indexed tokenId,
        Side side,
        uint256 entryPrice18,
        uint32 stakedCount
    );
    event Unstaked(uint64 indexed epochId, address indexed owner, uint256 indexed tokenId);
    event UnstakeProgressed(uint64 indexed epochId, uint32 cursor, uint32 stakedCount);
    event AutoUnstakeFailed(uint64 indexed epochId, address indexed owner, uint256 indexed tokenId);

    /// @notice One settlement price per epoch - the keeper's off-chain short average,
    ///         anchored on-chain against a fresh Pyth read (`anchorPrice18`). The sample
    ///         window + hash make the average auditable off-chain.
    event SettlementPriceSubmitted(
        uint64 indexed epochId,
        uint256 finalPrice18,
        uint256 anchorPrice18,
        uint64 sampleStart,
        uint64 sampleEnd,
        bytes32 samplesHash
    );

    /// @notice Per-position outcome (the heart of the entry-anchored model).
    event PositionProcessed(
        uint64 indexed epochId,
        uint256 indexed tokenId,
        bool won,
        int256 changeBps,
        uint128 feeBase,
        uint128 feeUSDC,
        uint256 contributionUsd6
    );
    event ProcessFailed(uint64 indexed epochId, uint256 indexed tokenId);
    event ProcessProgressed(uint64 indexed epochId, uint32 cursor, uint32 stakedCount);

    event EpochSettled(
        uint64 indexed epochId, uint256 finalPrice18, uint32 winnerCount, uint256 potBase, uint256 potUSDC
    );
    event RolloverInjected(uint64 indexed epochId, uint256 baseIn, uint256 usdcIn);
    event EmptyWinnerRollover(uint64 indexed epochId, uint256 potBase, uint256 potUSDC);
    event Claimed(
        uint64 indexed epochId, address indexed owner, uint256 indexed tokenId, uint256 payBase, uint256 payUSDC
    );
    event EmergencySettled(uint64 indexed epochId);
}
