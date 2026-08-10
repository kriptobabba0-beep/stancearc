// abi.ts — minimal ABIs the keeper needs. Signatures mirror the real artifacts in
// frontend/abis/feeArena.ts and frontend/abis/pyth.ts EXACTLY (field order/types).
// `as const` is required for viem's type inference; on-chain numerics decode to bigint.

/**
 * FeeArena surface used by the keeper: the four privileged/permissionless lifecycle
 * cranks, the two settlement-back-half cranks, and the reads needed to build state.
 * currentEpoch() returns the full EpochView tuple (mirrors IFeeArena.EpochView 1:1).
 */
export const feeArenaAbi = [
  // ---- reads ----
  { type: 'function', name: 'currentEpochId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  {
    type: 'function',
    name: 'currentEpoch',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'epochId', type: 'uint64' },
          { name: 'phase', type: 'uint8' },
          { name: 'entryOpenTime', type: 'uint64' },
          { name: 'entryCloseTime', type: 'uint64' },
          { name: 'startTime', type: 'uint64' },
          { name: 'endTime', type: 'uint64' },
          { name: 'startTimeActual', type: 'uint64' },
          { name: 'settleTimeActual', type: 'uint64' },
          { name: 'bandBps', type: 'int32' },
          { name: 'startPrice18', type: 'uint256' },
          { name: 'settlePrice18', type: 'uint256' },
          { name: 'deltaBps', type: 'int256' },
          { name: 'winningSide', type: 'uint8' },
          { name: 'rolledOver', type: 'bool' },
          { name: 'stakedCount', type: 'uint32' },
          { name: 'sweepCursor', type: 'uint32' },
          { name: 'potWETH', type: 'uint256' },
          { name: 'potUSDC', type: 'uint256' },
          { name: 'sideContribution6', type: 'uint256[4]' },
          { name: 'winnerDenominator', type: 'uint256' },
          { name: 'rolloverPendingIn', type: 'bool' },
          { name: 'rolloverInWETH', type: 'uint256' },
          { name: 'rolloverInUSDC', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'sweepProgress',
    stateMutability: 'view',
    inputs: [{ name: 'epochId', type: 'uint64' }],
    outputs: [
      { name: 'done', type: 'uint32' },
      { name: 'total', type: 'uint32' },
    ],
  },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  // maxStartDelay is a plain public var, NOT part of EpochView — read separately so the
  // keeper can detect a missed (wedged) start window instead of reverting START forever.
  { type: 'function', name: 'maxStartDelay', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }] },
  // ---- v1 auto-return reads ----
  // The most recently Settled epoch (0 if none). Auto-return targets THIS epoch.
  { type: 'function', name: 'lastSettledEpochId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  // Auto-return cursor (public mapping getter) — fully on-chain, restart-proof. The total
  // is sweepProgress(epochId).total (== stakedCount); no dedicated unstakeProgress view
  // exists on-chain (the arena sits against the EIP-170 contract-size limit).
  { type: 'function', name: 'unstakeCursor', stateMutability: 'view', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'uint32' }] },
  // ---- lifecycle cranks ----
  { type: 'function', name: 'createEpoch', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'epochId', type: 'uint64' }] },
  { type: 'function', name: 'openEntry', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'startEpoch', stateMutability: 'payable', inputs: [{ name: 'priceData', type: 'bytes[]' }], outputs: [] },
  { type: 'function', name: 'endEpoch', stateMutability: 'payable', inputs: [{ name: 'priceData', type: 'bytes[]' }], outputs: [] },
  // ---- settlement back-half ----
  { type: 'function', name: 'sweep', stateMutability: 'nonpayable', inputs: [{ name: 'maxCount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'finalizeSettle', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  // Permissionless paginated auto-return: pushes a Settled epoch's escrowed NFTs back to
  // their owners (a reverting receiver is parked on-chain, never retried by the batch).
  { type: 'function', name: 'unstakeBatch', stateMutability: 'nonpayable', inputs: [{ name: 'epochId', type: 'uint64' }, { name: 'maxCount', type: 'uint256' }], outputs: [] },
  // ---- owner-only terminal recovery (OPTIONAL wedge auto-recovery) ----
  // emergencySettle(epochId, Side resolution) — onlyOwner escape hatch for a wedged epoch.
  // The keeper invokes this ONLY with the optional owner key (KEEPER_OWNER_PRIVATE_KEY) and
  // ONLY for a genuinely-wedged epoch after endTime+GRACE. `resolution` is the Side enum
  // (uint8); the keeper passes RANGE (3). Mirrors FeeArena.emergencySettle 1:1.
  { type: 'function', name: 'emergencySettle', stateMutability: 'nonpayable', inputs: [{ name: 'epochId', type: 'uint64' }, { name: 'resolution', type: 'uint8' }], outputs: [] },
  // ---- custom errors the keeper REACTS to ----
  // sweep() reverts this (selector 0x562d6d1b) when the epoch's internal phase is ALREADY
  // Swept/Settled. Declared here so viem decodes a revert to errorName 'SweepAlreadyDone',
  // letting the keeper treat a post-restart empty-epoch double-sweep as a BENIGN, recoverable
  // signal (mark swept -> finalize next tick) instead of a wedge-worthy failure. Mirrors
  // src/interfaces/IFeeArena.sol's `error SweepAlreadyDone();`.
  { type: 'error', name: 'SweepAlreadyDone', inputs: [] },
] as const;

/**
 * FeeArenaV2 surface used by the keeper. v2 differs from v1 ONLY in the SETTLE path: the
 * contract PINS the start/end price publishTime into a tight window
 * [endpointTime, endpointTime+settleWindow] via getPinnedPrice -> parsePriceFeedUpdates.
 * IMPORTANT: startEpoch/endEpoch's on-chain SIGNATURE is still `(bytes[] priceData)` — the
 * min/max publishTime is computed INSIDE the contract from the epoch's startTime/endTime +
 * `settleWindow`; the keeper does NOT pass them. The keeper's job is purely TIMING: post a
 * fresh blob (publishTime ~= now) while now is inside the window (see decideV2.ts).
 *
 * The EpochV2 tuple (currentEpoch/getEpoch) is a DIFFERENT shape from v1's EpochView (more
 * conviction/subsidy fields, different field ORDER, and NO leading `epochId`). It is mirrored
 * 1:1 from out/FeeArenaV2.sol/FeeArenaV2.json so viem decodes by name correctly; the
 * abi.test.ts drift guard asserts it stays in sync. The keeper reads phase / entryCloseTime /
 * startTime / endTime / settlePrice18 / sweepCursor / stakedCount from it.
 */
export const feeArenaV2Abi = [
  // ---- reads ----
  { type: 'function', name: 'currentEpochId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  {
    type: 'function',
    name: 'currentEpoch',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'phase', type: 'uint8' },
          { name: 'entryOpenTime', type: 'uint64' },
          { name: 'entryCloseTime', type: 'uint64' },
          { name: 'startTime', type: 'uint64' },
          { name: 'endTime', type: 'uint64' },
          { name: 'startTimeActual', type: 'uint64' },
          { name: 'settleTimeActual', type: 'uint64' },
          { name: 'winningSide', type: 'uint8' },
          { name: 'rolledOver', type: 'bool' },
          { name: 'rolloverConsumed', type: 'bool' },
          { name: 'sweepCursor', type: 'uint32' },
          { name: 'stakedCount', type: 'uint32' },
          { name: 'bandBps', type: 'int32' },
          { name: 'startPrice18', type: 'uint256' },
          { name: 'settlePrice18', type: 'uint256' },
          { name: 'deltaBps', type: 'int256' },
          { name: 'potWETH', type: 'uint256' },
          { name: 'potUSDC', type: 'uint256' },
          { name: 'sideContribution6', type: 'uint256[4]' },
          { name: 'winnerDenominator', type: 'uint256' },
          { name: 'claimedWETH', type: 'uint256' },
          { name: 'claimedUSDC', type: 'uint256' },
          { name: 'claimedCount', type: 'uint32' },
          { name: 'subsidyUSDC', type: 'uint256' },
          { name: 'sideConviction', type: 'uint256[4]' },
          { name: 'winnerSqrtConvSum', type: 'uint256' },
          { name: 'winningConvictionSum', type: 'uint256' },
          { name: 'refundedConviction', type: 'uint256' },
          { name: 'convRefundedCount', type: 'uint32' },
          { name: 'burnedConviction', type: 'uint256' },
        ],
      },
    ],
  },
  // getEpoch(epochId) returns the SAME EpochV2 tuple for an arbitrary epoch (used when
  // funding the subsidy by epochId / inspecting a specific epoch's phase).
  {
    type: 'function',
    name: 'getEpoch',
    stateMutability: 'view',
    inputs: [{ name: 'epochId', type: 'uint64' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'phase', type: 'uint8' },
          { name: 'entryOpenTime', type: 'uint64' },
          { name: 'entryCloseTime', type: 'uint64' },
          { name: 'startTime', type: 'uint64' },
          { name: 'endTime', type: 'uint64' },
          { name: 'startTimeActual', type: 'uint64' },
          { name: 'settleTimeActual', type: 'uint64' },
          { name: 'winningSide', type: 'uint8' },
          { name: 'rolledOver', type: 'bool' },
          { name: 'rolloverConsumed', type: 'bool' },
          { name: 'sweepCursor', type: 'uint32' },
          { name: 'stakedCount', type: 'uint32' },
          { name: 'bandBps', type: 'int32' },
          { name: 'startPrice18', type: 'uint256' },
          { name: 'settlePrice18', type: 'uint256' },
          { name: 'deltaBps', type: 'int256' },
          { name: 'potWETH', type: 'uint256' },
          { name: 'potUSDC', type: 'uint256' },
          { name: 'sideContribution6', type: 'uint256[4]' },
          { name: 'winnerDenominator', type: 'uint256' },
          { name: 'claimedWETH', type: 'uint256' },
          { name: 'claimedUSDC', type: 'uint256' },
          { name: 'claimedCount', type: 'uint32' },
          { name: 'subsidyUSDC', type: 'uint256' },
          { name: 'sideConviction', type: 'uint256[4]' },
          { name: 'winnerSqrtConvSum', type: 'uint256' },
          { name: 'winningConvictionSum', type: 'uint256' },
          { name: 'refundedConviction', type: 'uint256' },
          { name: 'convRefundedCount', type: 'uint32' },
          { name: 'burnedConviction', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'sweepProgress',
    stateMutability: 'view',
    inputs: [{ name: 'epochId', type: 'uint64' }],
    outputs: [
      { name: 'done', type: 'uint32' },
      { name: 'total', type: 'uint32' },
    ],
  },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'maxStartDelay', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }] },
  // USDC token of this arena — read so the keeper can approve it to the arena before fundSubsidy.
  { type: 'function', name: 'USDC', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  // v2 pin width: the start/end publishTime is forced into [endpointTime, endpointTime+settleWindow].
  // Read so the keeper can compute the window (hard-capped at 60 by decideV2.effectiveSettleWindow).
  { type: 'function', name: 'settleWindow', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }] },
  // v2 per-epoch subsidy hard cap (raw USDC, 6-dp). The keeper clamps a configured subsidy to it.
  { type: 'function', name: 'maxSubsidyPerEpoch', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  // ---- lifecycle cranks (structurally identical to v1) ----
  { type: 'function', name: 'createEpoch', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'epochId', type: 'uint64' }] },
  { type: 'function', name: 'openEntry', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  // PINNED start/end. Signature is (bytes[]) — the contract pins the publishTime window itself.
  { type: 'function', name: 'startEpoch', stateMutability: 'payable', inputs: [{ name: 'priceData', type: 'bytes[]' }], outputs: [] },
  { type: 'function', name: 'endEpoch', stateMutability: 'payable', inputs: [{ name: 'priceData', type: 'bytes[]' }], outputs: [] },
  // ---- settlement back-half (structurally identical to v1) ----
  { type: 'function', name: 'sweep', stateMutability: 'nonpayable', inputs: [{ name: 'maxCount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'finalizeSettle', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  // ---- owner-only OPTIONAL external-value injection (v2) ----
  // fundSubsidy(epochId, amount) — onlyOwner, phase < Resolved, hard-capped at maxSubsidyPerEpoch.
  // Needs a prior USDC approve to the arena. Called by the keeper's OWNER key when configured.
  { type: 'function', name: 'fundSubsidy', stateMutability: 'nonpayable', inputs: [{ name: 'epochId', type: 'uint64' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  // ---- owner-only terminal recovery (OPTIONAL wedge auto-recovery, identical surface to v1) ----
  { type: 'function', name: 'emergencySettle', stateMutability: 'nonpayable', inputs: [{ name: 'epochId', type: 'uint64' }, { name: 'resolution', type: 'uint8' }], outputs: [] },
  // ---- custom errors the keeper REACTS to ----
  // Identical to v1: sweep() on an already-Swept/Settled epoch reverts SweepAlreadyDone
  // (selector 0x562d6d1b). FeeArenaV2's phase-collapse maps Swept(4)->Running too, so v2 also
  // can't distinguish Swept-empty from Resolved-empty post-restart — declaring the error here
  // lets the keeper auto-recover a v2 empty-epoch double-sweep the same benign way as v1.
  { type: 'error', name: 'SweepAlreadyDone', inputs: [] },
] as const;

/**
 * FeeArenaV3 (ENTRY-ANCHORED) surface used by the keeper. v3 has NO startEpoch — the
 * lifecycle is create -> open -> (entry + locked watch, pure time gating) ->
 * submitSettlementPrice (the keeper's off-chain 60s average, anchored on-chain against a
 * fresh Pyth read) -> processPositions batches (per-position outcomes) -> finalizeEpoch ->
 * unstakeBatch (auto-return). currentEpoch() returns the EpochView with the DERIVED
 * 5-phase PhaseView (Idle/EntryOpen/Locked/Settling/Settled) — no collapse needed here.
 */
export const feeArenaV3Abi = [
  // ---- reads ----
  { type: 'function', name: 'currentEpochId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  {
    type: 'function',
    name: 'currentEpoch',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'epochId', type: 'uint64' },
          { name: 'phase', type: 'uint8' },
          { name: 'entryOpenTime', type: 'uint64' },
          { name: 'entryCloseTime', type: 'uint64' },
          { name: 'settlementTime', type: 'uint64' },
          { name: 'settleTimeActual', type: 'uint64' },
          { name: 'bandBps', type: 'int32' },
          { name: 'rolledOver', type: 'bool' },
          { name: 'stakedCount', type: 'uint32' },
          { name: 'processedCursor', type: 'uint32' },
          { name: 'winnerCount', type: 'uint32' },
          { name: 'claimedCount', type: 'uint32' },
          { name: 'finalPrice18', type: 'uint256' },
          { name: 'potBase', type: 'uint256' },
          { name: 'potUSDC', type: 'uint256' },
          { name: 'totalWinnerContribution', type: 'uint256' },
          { name: 'rolloverPendingIn', type: 'bool' },
          { name: 'rolloverInBase', type: 'uint256' },
          { name: 'rolloverInUSDC', type: 'uint256' },
        ],
      },
    ],
  },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'lastSettledEpochId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'unstakeCursor', stateMutability: 'view', inputs: [{ name: '', type: 'uint64' }], outputs: [{ name: '', type: 'uint32' }] },
  {
    type: 'function',
    name: 'processProgress',
    stateMutability: 'view',
    inputs: [{ name: 'epochId', type: 'uint64' }],
    outputs: [
      { name: 'done', type: 'uint32' },
      { name: 'total', type: 'uint32' },
    ],
  },
  // ---- lifecycle cranks ----
  { type: 'function', name: 'createEpoch', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'epochId', type: 'uint64' }] },
  { type: 'function', name: 'openEntry', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  // The single settlement submission: finalPrice = the keeper's off-chain short average;
  // sample window + hash are recorded for auditability; priceData = a FRESH Pyth blob the
  // contract uses as the on-chain sanity anchor (|final - anchor| <= settleSanityBps).
  {
    type: 'function',
    name: 'submitSettlementPrice',
    stateMutability: 'payable',
    inputs: [
      { name: 'epochId', type: 'uint64' },
      { name: 'finalPrice18', type: 'uint256' },
      { name: 'sampleStart', type: 'uint64' },
      { name: 'sampleEnd', type: 'uint64' },
      { name: 'samplesHash', type: 'bytes32' },
      { name: 'priceData', type: 'bytes[]' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'processPositions', stateMutability: 'nonpayable', inputs: [{ name: 'epochId', type: 'uint64' }, { name: 'maxCount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'finalizeEpoch', stateMutability: 'nonpayable', inputs: [{ name: 'epochId', type: 'uint64' }], outputs: [] },
  { type: 'function', name: 'unstakeBatch', stateMutability: 'nonpayable', inputs: [{ name: 'epochId', type: 'uint64' }, { name: 'maxCount', type: 'uint256' }], outputs: [] },
  // emergencySettle(epochId) — onlyOwner escape hatch the v3 keeper auto-fires after the on-chain
  // GRACE elapses when an epoch can't settle (dead oracle). NOTE: v3 takes ONE arg (no Side) — unlike
  // the v1/v2 two-arg version above; emergencySettle rolls all collected fees forward, no resolution.
  { type: 'function', name: 'emergencySettle', stateMutability: 'nonpayable', inputs: [{ name: 'epochId', type: 'uint64' }], outputs: [] },
  // maxPriceAge() — the on-chain freshness bound, read by the SETTLE projected-mine gate. (Was absent
  // here, so that read always threw and the gate was dead code — adding it revives the gate.)
  { type: 'function', name: 'maxPriceAge', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint32' }] },
] as const;

/**
 * The PINNED oracle read surface (PythPriceOracleV2 / any IPinnedPriceOracle). NOTE: the
 * keeper does NOT call getPinnedPrice directly — FeeArenaV2.startEpoch/endEpoch call it
 * INTERNALLY (forwarding the WHOLE msg.value as the parse fee). It is mirrored here for
 * completeness / documentation of the v2 settle boundary: getPinnedPrice runs
 * pyth.parsePriceFeedUpdates(updateData, [feedId], minPublishTime, maxPublishTime), which
 * REVERTS (PriceFeedNotFoundWithinRange) unless the blob's publishTime is in [min,max] —
 * THIS is what pins the timestamp and what the keeper's decideV2 window logic respects so
 * the posted blob lands in-window. (The keeper still prices the fee via Pyth.getUpdateFee,
 * exactly as v1 — see pythAbi below.)
 */
export const pinnedOracleAbi = [
  {
    type: 'function',
    name: 'getPinnedPrice',
    stateMutability: 'payable',
    inputs: [
      { name: 'updateData', type: 'bytes[]' },
      { name: 'minPublishTime', type: 'uint64' },
      { name: 'maxPublishTime', type: 'uint64' },
    ],
    outputs: [
      { name: 'price18', type: 'uint256' },
      { name: 'conf18', type: 'uint256' },
      { name: 'publishTime', type: 'uint64' },
    ],
  },
] as const;

/**
 * Minimal Uniswap-V3 pool surface for the arb bot: slot0() (sqrtPriceX96 + tick) and
 * liquidity() (current in-range liquidity). Mirrors the canonical IUniswapV3Pool. Only
 * the fields the arb decision needs are decoded; slot0 returns the full 7-tuple so the
 * ABI must list every component in order for viem to decode it.
 */
export const v3PoolAbi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint128' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint24' }] },
] as const;

/**
 * Uniswap-V3 SwapRouter.exactInputSingle: a single-pool exact-input swap. The struct is
 * passed as one tuple arg. sqrtPriceLimitX96 is PINNED to the ref-target tick by the arb
 * bot so the AMM bounds the swap and can never push the pool past the oracle.
 *
 * multicall(bytes[]) is the SwapRouter's inherited Multicall — it delegatecalls each encoded
 * call in ONE tx, sharing the caller's approvals. The epoch-mode swap bot uses it to fire a
 * balanced [SELL, BUY] pair ATOMICALLY: if either embedded exactInputSingle reverts, the whole
 * tx reverts and the pool is provably never left pushed off the peg (no residual long can form).
 */
export const swapRouterAbi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const;

/** Minimal ERC20 surface: read the bot's base/USDC inventory + approve the router. */
export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

/**
 * Minimal IPyth surface: getUpdateFee prices a signed Hermes update; the value is
 * paid alongside FeeArena.startEpoch/endEpoch (which forward it to Pyth).
 */
export const pythAbi = [
  {
    type: 'function',
    name: 'getUpdateFee',
    stateMutability: 'view',
    inputs: [{ name: 'updateData', type: 'bytes[]' }],
    outputs: [{ name: 'feeAmount', type: 'uint256' }],
  },
] as const;
