// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IFeeArenaV3} from "./interfaces/IFeeArenaV3.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/IUniswapV3Factory.sol";

interface IERC20DecimalsV3 {
    function decimals() external view returns (uint8);
}

/// @title FeeArenaV3 - the ENTRY-ANCHORED Fee Arena (fee_arena_entry_anchored_btc_model.pdf).
///
/// @notice What changed vs v1 (global-start model):
///         - NO global epoch start price and NO startEpoch crank. The entry window can be
///           arbitrarily long because every position anchors to ITS OWN `entryPrice18` -
///           a fresh oracle read inside the stake transaction, slippage-guarded by the
///           caller (`expectedEntryPrice18` / `maxDeviationBps`). A late entrant anchors
///           to the later price and gains nothing for free.
///         - ONE settlement price per epoch: the keeper computes a short off-chain average
///           (e.g. the last 60s of Pyth prices) and submits it with the sample window +
///           samples hash; the contract ANCHORS it against a fresh on-chain Pyth read
///           (must be within `settleSanityBps`) so the submitted average can never stray
///           from the oracle.
///         - Outcomes are PER POSITION: changeBps = (final - entry) * 10_000 / entry;
///           UP correct iff changeBps >= +band (inclusive), DOWN iff <= -band (inclusive),
///           RANGE iff strictly inside. There is no global winning side.
///         - Fee split: winners KEEP the fees their own position produced and additionally
///           split the LOSERS' forfeited fees pro-rata by `contributionUsd6` (the USD
///           notional of the fees the position produced: feeUSDC + feeBase * finalPrice).
///           Losers never lose principal - only that epoch's fees.
///         - `processPositions` replaces sweep: a paginated, permissionless crank that
///           collects each position's fees and resolves its outcome (try/catch isolated -
///           one bad position can never brick the epoch).
///         - Auto-return carries over from v1: after Settled, the permissionless
///           gas-bounded `unstakeBatch` pushes every NFT home (park-and-continue).
contract FeeArenaV3 is IFeeArenaV3, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---- constants ----
    uint256 internal constant BPS = 10_000;
    bytes4 internal constant ERC721_RECEIVED = 0x150b7a02;
    uint8 public constant PRICE_DECIMALS = 18;
    uint64 public constant GRACE = 600;
    /// @dev Gas forwarded per NFT return in `unstakeBatch` (hostile receiver parks itself).
    uint256 internal constant AUTO_RETURN_GAS = 300_000;

    // ---- immutables ----
    address public immutable USDC;
    address public immutable BASE; // the non-USDC leg (cirBTC)
    address public immutable POOL;
    address public immutable NPM;
    address public immutable FACTORY;
    address public immutable ORACLE;
    uint24 public immutable FEE_TIER;
    uint128 public immutable MIN_LIQUIDITY;
    /// @dev feeBase(baseDecimals) * price(18dp) / NOTIONAL_DIV == USD 6dp notional.
    uint256 public immutable NOTIONAL_DIV;
    uint8 public immutable baseIsToken0;

    // ---- mutable config (snapshotted into the epoch at create) ----
    uint32 public entryWindow; // entryOpen -> entryClose (the long entry window)
    uint32 public lockDuration; // entryClose -> settlementTime (locked watch period)
    uint32 public maxPriceAge; // freshness gate for every oracle read
    int32 public bandBps; // per-position outcome band (inclusive at +/- band)
    uint32 public settleSanityBps; // |finalPrice - pyth anchor| bound at settlement
    uint32 public maxStakesPerEpoch;
    uint32 public maxStakesPerUser;

    // ---- storage ----
    mapping(uint64 => Epoch) internal epochs;
    mapping(uint256 => Position) public positions;
    mapping(uint64 => uint256[]) internal epochTokenIds;
    mapping(address => mapping(uint64 => uint256[])) public userEpochTokenIds;
    mapping(address => uint256) public lastStakeBlock;
    /// @notice Auto-return cursor per epoch (count of epochTokenIds entries pushed).
    mapping(uint64 => uint32) public unstakeCursor;

    uint64 public currentEpochId;
    uint64 public lastSettledEpochId;
    uint256 public rolloverBase;
    uint256 public rolloverUSDC;

    /// @notice Running aggregate of every settled epoch's still-unclaimed obligation
    ///         (Σ escrow - claimed). Maintained incrementally at finalize/claim/emergencySettle so
    ///         the solvency invariant is O(1) - finalize never loops over history, so its gas is
    ///         FLAT no matter how many rounds the arena has run (the v3 unbounded-finalize fix).
    uint256 public obligationBase;
    uint256 public obligationUSDC;

    /// @notice Least-privilege keeper: createEpoch/openEntry/submitSettlementPrice only.
    address public keeper;

    constructor(BootConfig memory c) Ownable() {
        NOTIONAL_DIV = _bootValidate(c);
        (USDC, BASE, POOL, NPM, FACTORY, ORACLE) = (c.usdc, c.base, c.pool, c.npm, c.factory, c.oracle);
        FEE_TIER = c.feeTier;
        MIN_LIQUIDITY = c.minLiquidity;
        baseIsToken0 = INonfungiblePositionManagerToken0(c.pool).token0() == c.base ? 1 : 0;
        _initConfig(c);
        _transferOwnership(c.owner);
    }

    /// @dev Boot asserts + the notional divisor. Helper keeps the ctor stack shallow
    ///      (via-ir is OFF in the mixed-solc workspace).
    function _bootValidate(BootConfig memory c) private view returns (uint256 notionalDiv) {
        if (
            c.usdc == address(0) || c.base == address(0) || c.pool == address(0) || c.npm == address(0)
                || c.factory == address(0) || c.oracle == address(0) || c.owner == address(0)
        ) revert ZeroAddress();
        uint8 ud = IERC20DecimalsV3(c.usdc).decimals();
        uint8 bd = IERC20DecimalsV3(c.base).decimals();
        if (ud != 6) revert BadDecimals();
        if (INonfungiblePositionManager(c.npm).factory() != c.factory) revert NotPool();
        if (c.bandBps <= 0 || c.bandBps >= int32(int256(BPS))) revert BandOutOfRange();
        if (c.settleSanityBps == 0 || c.settleSanityBps >= BPS) revert BandOutOfRange();
        // feeBase(bd dp) * price18 -> USD 6dp: divide by 10^(bd + 18 - 6).
        notionalDiv = 10 ** (uint256(bd) + uint256(PRICE_DECIMALS) - uint256(ud));
    }

    function _initConfig(BootConfig memory c) private {
        entryWindow = c.entryWindow;
        lockDuration = c.lockDuration;
        maxPriceAge = c.maxPriceAge;
        bandBps = c.bandBps;
        settleSanityBps = c.settleSanityBps;
    }

    // ---- keeper role + owner config ----

    function setKeeper(address newKeeper) external onlyOwner {
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    modifier onlyOwnerOrKeeper() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotOwnerOrKeeper();
        _;
    }

    function setTiming(uint32 entryWindow_, uint32 lockDuration_, uint32 maxPriceAge_) external onlyOwner {
        entryWindow = entryWindow_;
        lockDuration = lockDuration_;
        maxPriceAge = maxPriceAge_;
        emit TimingUpdated(entryWindow_, lockDuration_, maxPriceAge_);
    }

    function setBand(int32 bandBps_) external onlyOwner {
        if (bandBps_ <= 0 || bandBps_ >= int32(int256(BPS))) revert BandOutOfRange();
        bandBps = bandBps_;
        emit BandUpdated(bandBps_);
    }

    function setSettleSanity(uint32 settleSanityBps_) external onlyOwner {
        if (settleSanityBps_ == 0 || settleSanityBps_ >= BPS) revert BandOutOfRange();
        settleSanityBps = settleSanityBps_;
        emit SettleSanityUpdated(settleSanityBps_);
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

    // ---- lifecycle: create / open ----

    function createEpoch() external onlyOwnerOrKeeper returns (uint64 epochId) {
        if (currentEpochId != 0) {
            if (epochs[currentEpochId].phase != Phase.Settled) revert PrevNotSettled();
        }
        epochId = currentEpochId + 1;
        uint64 entryOpen = uint64(block.timestamp);
        uint64 entryClose = entryOpen + entryWindow;
        uint64 settlement = entryClose + lockDuration;
        if (!(entryOpen < entryClose && entryClose < settlement)) revert BadTimes();
        int32 band = bandBps;
        if (band <= 0 || band >= int32(int256(BPS))) revert BandOutOfRange();

        Epoch storage e = epochs[epochId];
        e.phase = Phase.None;
        e.entryOpenTime = entryOpen;
        e.entryCloseTime = entryClose;
        e.settlementTime = settlement;
        e.bandBps = band;

        currentEpochId = epochId;
        emit EpochCreated(epochId, entryOpen, entryClose, settlement, band);
    }

    function openEntry() external onlyOwnerOrKeeper {
        Epoch storage e = epochs[currentEpochId];
        if (e.phase != Phase.None) revert WrongPhase();
        e.phase = Phase.EntryOpen;
    }

    // ---- staking (the entry anchor) ----

    /// @notice Stake an LP NFT on a side, anchored to a FRESH oracle price read in this
    ///         transaction. `priceData` is a Pyth/Hermes update blob (its fee is paid from
    ///         msg.value; excess refunds). The caller protects itself against a moving
    ///         price with `expectedEntryPrice18` + `maxDeviationBps`: if the on-chain read
    ///         deviates more, the stake reverts instead of silently anchoring elsewhere.
    ///         Requires the NFT to be approved to this contract (approve / setApprovalForAll).
    function stakeWithSide(
        uint256 tokenId,
        Side side,
        uint256 expectedEntryPrice18,
        uint256 maxDeviationBps,
        bytes[] calldata priceData
    ) external payable nonReentrant whenNotPaused {
        uint256 balBefore = address(this).balance - msg.value;
        Epoch storage ep = epochs[currentEpochId];

        // entry gate: phase + strict close boundary
        if (ep.phase != Phase.EntryOpen) revert NotEntryWindow();
        if (block.timestamp >= ep.entryCloseTime) revert NotEntryWindow();
        if (side != Side.UP && side != Side.DOWN && side != Side.RANGE) revert BadSide();

        _checkStakeGuards(msg.sender, side);
        _validatePool(tokenId);

        // THE ANCHOR: refresh the oracle, read, gate freshness + caller's deviation guard.
        IPriceOracle(ORACLE).update{value: msg.value}(priceData);
        (uint256 price18, uint256 updatedAt) = IPriceOracle(ORACLE).getPrice();
        _requireFresh(price18, updatedAt);
        _checkDeviation(price18, expectedEntryPrice18, maxDeviationBps);

        // pull the NFT (the minimal receiver hook below only accepts self-initiated pulls)
        INonfungiblePositionManager(NPM).safeTransferFrom(msg.sender, address(this), tokenId);

        // fairness: zero pre-existing fees to the staker so only [stake, settlement] counts
        INonfungiblePositionManager(NPM).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: msg.sender,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        _recordStake(ep, msg.sender, tokenId, side, price18);
        _refundExcess(balBefore);
    }

    /// @notice Minimal ERC721 receiver: ONLY this contract's own `safeTransferFrom` pull
    ///         (operator == address(this)) is accepted. Direct transfers with side data -
    ///         the v1 stake path - are rejected: a v3 stake MUST go through `stakeWithSide`
    ///         so the entry price is read + guarded in the same transaction.
    function onERC721Received(address operator, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != NPM || operator != address(this)) revert NotNPM();
        return ERC721_RECEIVED;
    }

    /// @dev Same-block + one-side-per-epoch + dust-flood caps (mirrors v1 guards).
    function _checkStakeGuards(address from, Side side) internal {
        if (lastStakeBlock[from] >= block.number) revert SameBlock();
        lastStakeBlock[from] = block.number;
        uint256[] storage mine = userEpochTokenIds[from][currentEpochId];
        uint256 userCount = mine.length;
        if (userCount > 0) {
            if (side != positions[mine[0]].side) revert OneSidePerEpoch();
        }
        if (maxStakesPerUser != 0 && userCount + 1 > maxStakesPerUser) revert CapExceeded();
        if (maxStakesPerEpoch != 0 && uint256(epochs[currentEpochId].stakedCount) + 1 > maxStakesPerEpoch) {
            revert CapExceeded();
        }
    }

    /// @dev Pool/fee-tier/MIN_LIQUIDITY validation via factory.getPool (no init-code hash).
    function _validatePool(uint256 tokenId) internal view {
        (,, address t0, address t1, uint24 fee,,, uint128 liquidity,,,,) =
            INonfungiblePositionManager(NPM).positions(tokenId);
        if (fee != FEE_TIER) revert NotPool();
        if (IUniswapV3Factory(FACTORY).getPool(t0, t1, fee) != POOL) revert NotPool();
        if (liquidity < MIN_LIQUIDITY) revert InsufficientLiquidity();
    }

    /// @dev |actual - expected| must be within expected * maxDeviationBps / 10_000.
    ///      A zero expectation is rejected - the caller must state what it saw.
    function _checkDeviation(uint256 actual, uint256 expected, uint256 maxBps) internal pure {
        if (expected == 0) revert EntryPriceDeviation();
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        if (diff * BPS > expected * maxBps) revert EntryPriceDeviation();
    }

    function _recordStake(Epoch storage ep, address from, uint256 tokenId, Side side, uint256 price18) internal {
        positions[tokenId] = Position({
            owner: from,
            epochId: currentEpochId,
            side: side,
            processed: false,
            won: false,
            claimed: false,
            unstaked: false,
            entryTime: uint64(block.timestamp),
            entryPrice18: SafeCast.toUint128(price18),
            feeBase: 0,
            feeUSDC: 0,
            contributionUsd6: 0
        });
        epochTokenIds[currentEpochId].push(tokenId);
        userEpochTokenIds[from][currentEpochId].push(tokenId);
        ep.stakedCount += 1;
        emit Staked(currentEpochId, from, tokenId, side, price18, ep.stakedCount);
    }

    // ---- settlement: one final price, anchored ----

    /// @notice Submit the epoch's single settlement price (the keeper's off-chain short
    ///         average - e.g. the last 60s of Pyth prices). The submitted value is ANCHORED:
    ///         a fresh Pyth read (from `priceData`, publishTime >= settlementTime) must be
    ///         within `settleSanityBps` of `finalPrice18`, so a keeper can never submit a
    ///         price the oracle doesn't corroborate. Sample window + hash are emitted for
    ///         off-chain auditability.
    function submitSettlementPrice(
        uint64 epochId,
        uint256 finalPrice18,
        uint64 sampleStart,
        uint64 sampleEnd,
        bytes32 samplesHash,
        bytes[] calldata priceData
    ) external payable onlyOwnerOrKeeper nonReentrant whenNotPaused {
        uint256 balBefore = address(this).balance - msg.value;
        if (epochId != currentEpochId) revert WrongPhase();
        Epoch storage e = epochs[epochId];
        if (e.phase != Phase.EntryOpen) revert WrongPhase();
        if (block.timestamp < e.settlementTime) revert SettleTooEarly();
        if (finalPrice18 == 0) revert ZeroPrice();

        IPriceOracle(ORACLE).update{value: msg.value}(priceData);
        (uint256 anchor, uint256 updatedAt) = IPriceOracle(ORACLE).getPrice();
        _requireFresh(anchor, updatedAt);
        if (updatedAt < e.settlementTime) revert SettlePriceTooOld();
        uint256 diff = finalPrice18 > anchor ? finalPrice18 - anchor : anchor - finalPrice18;
        if (diff * BPS > anchor * settleSanityBps) revert SettlePriceOutOfBounds();

        e.finalPrice18 = finalPrice18;
        e.settleTimeActual = uint64(block.timestamp);
        e.phase = Phase.Priced;
        emit SettlementPriceSubmitted(epochId, finalPrice18, anchor, sampleStart, sampleEnd, samplesHash);
        _refundExcess(balBefore);
    }

    // ---- batch processing: per-position outcomes ----

    /// @notice Process up to `maxCount` positions of a Priced epoch: collect the fees each
    ///         position produced, resolve its outcome against ITS OWN entryPrice, and route
    ///         the fees (winner keeps, loser forfeits into the pot). Permissionless and
    ///         resumable via `processedCursor`; a reverting collect is isolated by
    ///         try/catch (position parked with zero fees/contribution) so one bad position
    ///         can never brick the epoch.
    function processPositions(uint64 epochId, uint256 maxCount) external nonReentrant whenNotPaused {
        Epoch storage e = epochs[epochId];
        if (e.phase != Phase.Priced) revert WrongPhase();

        uint256[] storage ids = epochTokenIds[epochId];
        uint32 cursor = e.processedCursor;
        uint32 total = e.stakedCount;
        uint256 end = uint256(cursor) + maxCount;
        if (end > total) end = total;

        for (uint256 i = cursor; i < end; ++i) {
            uint256 tokenId = ids[i];
            Position storage p = positions[tokenId];
            if (p.processed) continue; // defensive; cursor normally guarantees unprocessed
            try this.externalCollect(tokenId) returns (uint256 feeB, uint256 feeU) {
                _settleOutcome(e, p, epochId, tokenId, feeB, feeU);
            } catch {
                p.processed = true; // park: zero fees, zero contribution, not a winner
                emit ProcessFailed(epochId, tokenId);
            }
        }
        e.processedCursor = uint32(end);
        emit ProcessProgressed(epochId, uint32(end), total);
        _assertSolvent();
    }

    /// @dev Outcome + fee routing for one position (helper keeps the loop stack shallow).
    function _settleOutcome(
        Epoch storage e,
        Position storage p,
        uint64 epochId,
        uint256 tokenId,
        uint256 feeB,
        uint256 feeU
    ) internal {
        uint128 fb = SafeCast.toUint128(feeB);
        uint128 fu = SafeCast.toUint128(feeU);
        // USD 6dp notional of the fees this position produced this epoch.
        uint256 c = uint256(fu) + (uint256(fb) * e.finalPrice18) / NOTIONAL_DIV;
        (int256 ch, Side correct) = outcomeOf(p.entryPrice18, e.finalPrice18, e.bandBps);
        bool won = (p.side == correct);

        p.processed = true;
        p.won = won;
        p.feeBase = fb;
        p.feeUSDC = fu;
        p.contributionUsd6 = c;

        // ALL collected fees are escrowed by the contract (winner-kept fees included) -
        // the solvency invariant counts escrow - claimed per settled epoch.
        e.escrowBase += feeB;
        e.escrowUSDC += feeU;
        if (won) {
            if (c > 0) {
                e.totalWinnerContribution += c;
                e.winnerCount += 1; // claim-eligible winners only (zero-fee winners owe/get nothing)
            }
        } else {
            // forfeited: the loser pot the winners will split
            e.potBase += feeB;
            e.potUSDC += feeU;
        }
        emit PositionProcessed(epochId, tokenId, won, ch, fb, fu, c);
    }

    /// @notice External-self wrapper so a reverting `NPM.collect` is isolated by the
    ///         try/catch in `processPositions`. Returns (BASE leg, USDC leg).
    function externalCollect(uint256 tokenId) external returns (uint256 feeBase_, uint256 feeUsdc_) {
        require(msg.sender == address(this), "self");
        (uint256 a0, uint256 a1) = INonfungiblePositionManager(NPM).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (feeBase_, feeUsdc_) = baseIsToken0 == 1 ? (a0, a1) : (a1, a0);
    }

    /// @notice The per-position outcome rule (pure; UI/tests mirror this exactly).
    ///         changeBps >= +band -> UP correct (inclusive); <= -band -> DOWN correct
    ///         (inclusive); strictly inside -> RANGE correct.
    function outcomeOf(uint256 entryPrice18, uint256 finalPrice18, int32 band)
        public
        pure
        returns (int256 changeBps, Side correctSide)
    {
        changeBps = ((int256(finalPrice18) - int256(entryPrice18)) * int256(BPS)) / int256(entryPrice18);
        int256 b = int256(band);
        if (changeBps >= b) return (changeBps, Side.UP);
        if (changeBps <= -b) return (changeBps, Side.DOWN);
        return (changeBps, Side.RANGE);
    }

    // ---- finalize: rollover + claims open ----

    /// @notice Finalize the next-in-order fully-processed epoch. Injects any pending
    ///         rollover into the pot exactly once; if NO winner produced fees, the whole
    ///         pot rolls forward to the next epoch (never to the house). Flips to Settled,
    ///         which opens claims + the auto-return.
    function finalizeEpoch(uint64 epochId) external nonReentrant whenNotPaused {
        if (epochId != lastSettledEpochId + 1) revert WrongPhase();
        Epoch storage e = epochs[epochId];
        if (e.phase != Phase.Priced) revert WrongPhase();
        if (e.processedCursor != e.stakedCount) revert ProcessNotComplete();

        _injectRolloverOnce(epochId, e);

        if (e.totalWinnerContribution == 0) {
            // No claim-eligible winner: roll the whole pot forward. Winners' own fees are
            // necessarily zero here (a fee-producing winner would have contribution > 0),
            // so draining claimed == escrow leaves no phantom obligation.
            e.rolledOver = true;
            rolloverBase += e.potBase;
            rolloverUSDC += e.potUSDC;
            e.claimedBase = e.escrowBase;
            e.claimedUSDC = e.escrowUSDC;
            emit EmptyWinnerRollover(epochId, e.potBase, e.potUSDC);
        }

        lastSettledEpochId = epochId;
        e.phase = Phase.Settled;
        // Snapshot this epoch's net obligation into the running aggregate (after injection + any
        // empty-winner drain). For a rolled-over epoch claimed==escrow, so this adds exactly zero.
        obligationBase += (e.escrowBase - e.claimedBase);
        obligationUSDC += (e.escrowUSDC - e.claimedUSDC);
        emit EpochSettled(epochId, e.finalPrice18, e.winnerCount, e.potBase, e.potUSDC);
        _assertSolvent();
    }

    /// @dev Inject the pending global rollover into this epoch's pot exactly once. The
    ///      injected amount also joins `escrow` so the per-epoch solvency term
    ///      (escrow - claimed) covers it.
    function _injectRolloverOnce(uint64 id, Epoch storage e) internal {
        if (e.rolloverConsumed) revert RolloverAlreadyConsumed();
        e.rolloverConsumed = true;
        uint256 rb = rolloverBase;
        uint256 ru = rolloverUSDC;
        if (rb != 0 || ru != 0) {
            e.potBase += rb;
            e.potUSDC += ru;
            e.escrowBase += rb;
            e.escrowUSDC += ru;
            rolloverBase = 0;
            rolloverUSDC = 0;
            emit RolloverInjected(id, rb, ru);
        }
    }

    // ---- claim: own fees + pro-rata loser pot ----

    /// @notice Pull-based payout to the position's OWNER (regardless of caller - custody
    ///         independent, so the auto-return order never matters). A winner receives the
    ///         fees its own position produced PLUS its pro-rata share of the loser pot,
    ///         weighted by contributionUsd6. Floor division; pays at most once.
    function claim(uint256 tokenId) external nonReentrant {
        Position storage p = positions[tokenId];
        Epoch storage e = epochs[p.epochId];
        if (e.phase != Phase.Settled) revert NotSettled();
        if (e.rolledOver) revert NothingToClaim();
        if (!p.won) revert NotWinner();
        if (p.claimed) revert AlreadyClaimed();
        if (p.contributionUsd6 == 0) revert NothingToClaim();

        uint256 shareB = Math.mulDiv(e.potBase, p.contributionUsd6, e.totalWinnerContribution);
        uint256 shareU = Math.mulDiv(e.potUSDC, p.contributionUsd6, e.totalWinnerContribution);
        uint256 payB = uint256(p.feeBase) + shareB;
        uint256 payU = uint256(p.feeUSDC) + shareU;

        // EFFECTS first
        p.claimed = true;
        e.claimedBase += payB;
        e.claimedUSDC += payU;
        e.claimedCount += 1;
        // A claim retires part of this settled epoch's obligation by exactly the payout. The
        // solvency invariant guarantees (escrow - claimed) >= payout, so this never underflows.
        obligationBase -= payB;
        obligationUSDC -= payU;

        // INTERACTIONS last
        if (payB > 0) IERC20(BASE).safeTransfer(p.owner, payB);
        if (payU > 0) IERC20(USDC).safeTransfer(p.owner, payU);
        emit Claimed(p.epochId, p.owner, tokenId, payB, payU);
        _assertSolvent();
    }

    /// @notice Floor projection of a claim - mirrors `claim()` math exactly (UI gate).
    function previewClaim(uint256 tokenId) external view returns (ClaimPreview memory pv) {
        Position storage p = positions[tokenId];
        Epoch storage e = epochs[p.epochId];
        pv.isWinner = p.processed && p.won;
        pv.alreadyClaimed = p.claimed;
        if (p.entryPrice18 != 0 && e.finalPrice18 != 0) {
            (pv.changeBps,) = outcomeOf(p.entryPrice18, e.finalPrice18, e.bandBps);
        }
        pv.ownFeeBase = p.feeBase;
        pv.ownFeeUSDC = p.feeUSDC;
        if (pv.isWinner && e.totalWinnerContribution != 0) {
            pv.potShareBase = Math.mulDiv(e.potBase, p.contributionUsd6, e.totalWinnerContribution);
            pv.potShareUSDC = Math.mulDiv(e.potUSDC, p.contributionUsd6, e.totalWinnerContribution);
        }
        pv.claimable = (e.phase == Phase.Settled) && !e.rolledOver && pv.isWinner && !p.claimed
            && p.contributionUsd6 > 0;
    }

    // ---- unstake: manual pull + permissionless auto-return ----

    /// @notice Manual pull (the fallback): return the caller's escrowed NFT once Settled.
    ///         Deliberately NOT pause-gated - users can always recover their property.
    function unstake(uint256 tokenId) external nonReentrant {
        Position storage p = positions[tokenId];
        if (p.owner != msg.sender || p.unstaked) revert NotOwner();
        if (epochs[p.epochId].phase != Phase.Settled) revert NotSettled();
        p.unstaked = true;
        emit Unstaked(p.epochId, p.owner, tokenId);
        INonfungiblePositionManager(NPM).safeTransferFrom(address(this), p.owner, tokenId);
    }

    /// @notice AUTO-RETURN (permissionless): push up to `maxCount` escrowed NFTs of a
    ///         Settled epoch back to their owners. Mirrors v1's battle-tested pattern:
    ///         resumable cursor; per-token CEI; a receiver that reverts/burns gas/re-enters
    ///         is PARKED (skipped, stays owner-pullable via `unstake`) and never retried.
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
            if (p.unstaked) continue; // already pulled manually
            p.unstaked = true; // CEI; un-done in catch (sub-call revert doesn't revert us)
            try this.externalReturn{gas: AUTO_RETURN_GAS}(p.owner, tokenId) {
                emit Unstaked(epochId, p.owner, tokenId);
            } catch {
                p.unstaked = false; // park: stays escrowed + owner-pullable
                emit AutoUnstakeFailed(epochId, p.owner, tokenId);
            }
        }
        unstakeCursor[epochId] = uint32(end);
        emit UnstakeProgressed(epochId, uint32(end), total);
    }

    /// @notice External-self wrapper so a reverting NFT return is isolated by try/catch.
    function externalReturn(address to, uint256 tokenId) external {
        require(msg.sender == address(this), "self");
        INonfungiblePositionManager(NPM).safeTransferFrom(address(this), to, tokenId);
    }

    // ---- emergency escape hatch ----

    /// @notice Owner-only wedge escape: if the settlement price could not be submitted
    ///         (oracle dead / keeper dead) for GRACE past settlementTime, force-settle the
    ///         epoch so every NFT becomes unstakeable. Any ALREADY-collected fees roll to
    ///         the next epoch's pot (never to the house); uncollected fees travel with the
    ///         NFTs back to their owners. No claims open (nothing was resolved).
    function emergencySettle(uint64 epochId) external onlyOwner nonReentrant {
        if (epochId != lastSettledEpochId + 1 || epochId != currentEpochId) revert WrongPhase();
        Epoch storage e = epochs[epochId];
        if (e.phase != Phase.EntryOpen && e.phase != Phase.Priced) revert WrongPhase();
        if (block.timestamp <= uint256(e.settlementTime) + GRACE) revert GraceNotElapsed();

        // Everything collected so far (escrow) rolls forward; counters drain so the
        // solvency term for this epoch nets to zero.
        e.rolledOver = true;
        rolloverBase += e.escrowBase - e.claimedBase;
        rolloverUSDC += e.escrowUSDC - e.claimedUSDC;
        e.claimedBase = e.escrowBase;
        e.claimedUSDC = e.escrowUSDC;

        lastSettledEpochId = epochId;
        e.phase = Phase.Settled;
        // Everything was just rolled forward (claimed==escrow), so this epoch contributes zero
        // obligation; the funds are now tracked under rolloverBase/USDC. Added for symmetry.
        obligationBase += (e.escrowBase - e.claimedBase);
        obligationUSDC += (e.escrowUSDC - e.claimedUSDC);
        emit EmergencySettled(epochId);
        _assertSolvent();
    }

    // ---- views ----

    function getEpoch(uint64 epochId) external view returns (EpochView memory) {
        return _epochView(epochId);
    }

    function currentEpoch() external view returns (EpochView memory) {
        return _epochView(currentEpochId);
    }

    function _epochView(uint64 epochId) internal view returns (EpochView memory v) {
        Epoch storage e = epochs[epochId];
        PhaseView pv;
        if (e.phase == Phase.None) pv = PhaseView.Idle;
        else if (e.phase == Phase.EntryOpen) {
            pv = block.timestamp < e.entryCloseTime ? PhaseView.EntryOpen : PhaseView.Locked;
        } else if (e.phase == Phase.Priced) pv = PhaseView.Settling;
        else pv = PhaseView.Settled;

        v = EpochView({
            epochId: epochId,
            phase: pv,
            entryOpenTime: e.entryOpenTime,
            entryCloseTime: e.entryCloseTime,
            settlementTime: e.settlementTime,
            settleTimeActual: e.settleTimeActual,
            bandBps: e.bandBps,
            rolledOver: e.rolledOver,
            stakedCount: e.stakedCount,
            processedCursor: e.processedCursor,
            winnerCount: e.winnerCount,
            claimedCount: e.claimedCount,
            finalPrice18: e.finalPrice18,
            potBase: e.potBase,
            potUSDC: e.potUSDC,
            totalWinnerContribution: e.totalWinnerContribution,
            rolloverPendingIn: epochId == lastSettledEpochId + 1 && (rolloverBase > 0 || rolloverUSDC > 0),
            rolloverInBase: rolloverBase,
            rolloverInUSDC: rolloverUSDC
        });
    }

    function getStake(uint256 tokenId) external view returns (StakeView memory) {
        return _stakeView(tokenId);
    }

    function getStakesByEpoch(uint64 epochId) external view returns (StakeView[] memory out) {
        uint256[] storage ids = epochTokenIds[epochId];
        out = new StakeView[](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            out[i] = _stakeView(ids[i]);
        }
    }

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

    function _stakeView(uint256 tokenId) internal view returns (StakeView memory s) {
        Position storage p = positions[tokenId];
        s = StakeView({
            tokenId: tokenId,
            owner: p.owner,
            epochId: p.epochId,
            side: p.side,
            entryTime: p.entryTime,
            entryPrice18: p.entryPrice18,
            processed: p.processed,
            won: p.won,
            claimed: p.claimed,
            unstaked: p.unstaked,
            feeBase: p.feeBase,
            feeUSDC: p.feeUSDC,
            contributionUsd6: p.contributionUsd6
        });
    }

    /// @notice (done, total) processing progress (keeper crank gate).
    function processProgress(uint64 epochId) external view returns (uint32 done, uint32 total) {
        Epoch storage e = epochs[epochId];
        return (e.processedCursor, e.stakedCount);
    }

    // ---- internals ----

    function _requireFresh(uint256 price18, uint256 updatedAt) internal view {
        if (price18 == 0) revert ZeroPrice();
        if (block.timestamp > updatedAt + maxPriceAge) revert StalePrice();
    }

    function _refundExcess(uint256 balBefore) internal {
        uint256 bal = address(this).balance;
        if (bal > balBefore) {
            (bool ok,) = payable(msg.sender).call{value: bal - balBefore}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Accept the oracle's fee refund. No other native value is expected.
    receive() external payable {}

    /// @dev Solvency invariant: token balances must cover the global rollover plus every
    ///      settled-but-unclaimed obligation. O(1) - `obligationBase/USDC` is the running sum of
    ///      (escrow - claimed) across settled epochs, maintained incrementally at finalize / claim /
    ///      emergencySettle, so this check costs the same whether the arena has run 1 round or
    ///      1,000,000. (Rolled-over epochs net to zero - their funds move to rolloverBase/USDC.)
    function _assertSolvent() internal view {
        require(IERC20(BASE).balanceOf(address(this)) >= rolloverBase + obligationBase, "INSOLVENT_BASE");
        require(IERC20(USDC).balanceOf(address(this)) >= rolloverUSDC + obligationUSDC, "INSOLVENT_USDC");
    }
}

/// @dev Minimal pool token0 probe (avoids importing the full pool interface for one call).
interface INonfungiblePositionManagerToken0 {
    function token0() external view returns (address);
}
