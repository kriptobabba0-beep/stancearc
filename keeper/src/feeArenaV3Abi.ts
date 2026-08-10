// COPY — do NOT edit. The canonical file is frontend/abis/feeArenaV3.ts; the keeper cannot import across packages
// (its Docker build context is keeper/), so this is a byte-identical copy. Edit the canonical
// file and re-run `node scripts/sync-leaderboard-engine.mjs`. A test in BOTH suites fails the
// moment the two drift apart.
// abis/feeArenaV3.ts — FeeArenaV3 (ENTRY-ANCHORED) surface. Mirrors src/interfaces/IFeeArenaV3.sol
// EXACTLY (field order/types). v3 has NO startEpoch/endEpoch: stakes anchor their own entryPrice
// (read in the stake tx with a slippage guard) and one keeper-submitted settlement price closes
// the epoch; positions resolve INDIVIDUALLY (processPositions) and winners keep their own fees
// plus a pro-rata share of the losers' forfeited fees.
export const feeArenaV3Abi = [
  // ---- reads ----
  {"type":"function","name":"currentEpochId","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint64"}]},
  {"type":"function","name":"lastSettledEpochId","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint64"}]},
  {"type":"function","name":"owner","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address"}]},
  {"type":"function","name":"keeper","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address"}]},
  {"type":"function","name":"paused","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"bool"}]},
  {"type":"function","name":"bandBps","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"int32"}]},
  {"type":"function","name":"entryWindow","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint32"}]},
  {"type":"function","name":"lockDuration","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint32"}]},
  {"type":"function","name":"settleSanityBps","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint32"}]},
  {"type":"function","name":"maxPriceAge","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint32"}]},
  {"type":"function","name":"MIN_LIQUIDITY","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint128"}]},
  {"type":"function","name":"BASE","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address"}]},
  {"type":"function","name":"USDC","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address"}]},
  {"type":"function","name":"rolloverBase","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"rolloverUSDC","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"unstakeCursor","stateMutability":"view","inputs":[{"name":"","type":"uint64"}],"outputs":[{"name":"","type":"uint32"}]},
  {"type":"function","name":"processProgress","stateMutability":"view","inputs":[{"name":"epochId","type":"uint64"}],"outputs":[{"name":"done","type":"uint32"},{"name":"total","type":"uint32"}]},
  {"type":"function","name":"outcomeOf","stateMutability":"pure","inputs":[{"name":"entryPrice18","type":"uint256"},{"name":"finalPrice18","type":"uint256"},{"name":"band","type":"int32"}],"outputs":[{"name":"changeBps","type":"int256"},{"name":"correctSide","type":"uint8"}]},
  {"type":"function","name":"currentEpoch","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"tuple","components":[
    {"name":"epochId","type":"uint64"},{"name":"phase","type":"uint8"},{"name":"entryOpenTime","type":"uint64"},{"name":"entryCloseTime","type":"uint64"},{"name":"settlementTime","type":"uint64"},{"name":"settleTimeActual","type":"uint64"},{"name":"bandBps","type":"int32"},{"name":"rolledOver","type":"bool"},{"name":"stakedCount","type":"uint32"},{"name":"processedCursor","type":"uint32"},{"name":"winnerCount","type":"uint32"},{"name":"claimedCount","type":"uint32"},{"name":"finalPrice18","type":"uint256"},{"name":"potBase","type":"uint256"},{"name":"potUSDC","type":"uint256"},{"name":"totalWinnerContribution","type":"uint256"},{"name":"rolloverPendingIn","type":"bool"},{"name":"rolloverInBase","type":"uint256"},{"name":"rolloverInUSDC","type":"uint256"}]}]},
  {"type":"function","name":"getEpoch","stateMutability":"view","inputs":[{"name":"epochId","type":"uint64"}],"outputs":[{"name":"","type":"tuple","components":[
    {"name":"epochId","type":"uint64"},{"name":"phase","type":"uint8"},{"name":"entryOpenTime","type":"uint64"},{"name":"entryCloseTime","type":"uint64"},{"name":"settlementTime","type":"uint64"},{"name":"settleTimeActual","type":"uint64"},{"name":"bandBps","type":"int32"},{"name":"rolledOver","type":"bool"},{"name":"stakedCount","type":"uint32"},{"name":"processedCursor","type":"uint32"},{"name":"winnerCount","type":"uint32"},{"name":"claimedCount","type":"uint32"},{"name":"finalPrice18","type":"uint256"},{"name":"potBase","type":"uint256"},{"name":"potUSDC","type":"uint256"},{"name":"totalWinnerContribution","type":"uint256"},{"name":"rolloverPendingIn","type":"bool"},{"name":"rolloverInBase","type":"uint256"},{"name":"rolloverInUSDC","type":"uint256"}]}]},
  {"type":"function","name":"getStake","stateMutability":"view","inputs":[{"name":"tokenId","type":"uint256"}],"outputs":[{"name":"","type":"tuple","components":[
    {"name":"tokenId","type":"uint256"},{"name":"owner","type":"address"},{"name":"epochId","type":"uint64"},{"name":"side","type":"uint8"},{"name":"entryTime","type":"uint64"},{"name":"entryPrice18","type":"uint256"},{"name":"processed","type":"bool"},{"name":"won","type":"bool"},{"name":"claimed","type":"bool"},{"name":"unstaked","type":"bool"},{"name":"feeBase","type":"uint128"},{"name":"feeUSDC","type":"uint128"},{"name":"contributionUsd6","type":"uint256"}]}]},
  {"type":"function","name":"getStakesByEpoch","stateMutability":"view","inputs":[{"name":"epochId","type":"uint64"}],"outputs":[{"name":"","type":"tuple[]","components":[
    {"name":"tokenId","type":"uint256"},{"name":"owner","type":"address"},{"name":"epochId","type":"uint64"},{"name":"side","type":"uint8"},{"name":"entryTime","type":"uint64"},{"name":"entryPrice18","type":"uint256"},{"name":"processed","type":"bool"},{"name":"won","type":"bool"},{"name":"claimed","type":"bool"},{"name":"unstaked","type":"bool"},{"name":"feeBase","type":"uint128"},{"name":"feeUSDC","type":"uint128"},{"name":"contributionUsd6","type":"uint256"}]}]},
  {"type":"function","name":"getUserStakes","stateMutability":"view","inputs":[{"name":"user","type":"address"}],"outputs":[{"name":"","type":"tuple[]","components":[
    {"name":"tokenId","type":"uint256"},{"name":"owner","type":"address"},{"name":"epochId","type":"uint64"},{"name":"side","type":"uint8"},{"name":"entryTime","type":"uint64"},{"name":"entryPrice18","type":"uint256"},{"name":"processed","type":"bool"},{"name":"won","type":"bool"},{"name":"claimed","type":"bool"},{"name":"unstaked","type":"bool"},{"name":"feeBase","type":"uint128"},{"name":"feeUSDC","type":"uint128"},{"name":"contributionUsd6","type":"uint256"}]}]},
  {"type":"function","name":"previewClaim","stateMutability":"view","inputs":[{"name":"tokenId","type":"uint256"}],"outputs":[{"name":"","type":"tuple","components":[
    {"name":"claimable","type":"bool"},{"name":"isWinner","type":"bool"},{"name":"alreadyClaimed","type":"bool"},{"name":"changeBps","type":"int256"},{"name":"ownFeeBase","type":"uint256"},{"name":"ownFeeUSDC","type":"uint256"},{"name":"potShareBase","type":"uint256"},{"name":"potShareUSDC","type":"uint256"}]}]},
  // ---- writes ----
  {"type":"function","name":"stakeWithSide","stateMutability":"payable","inputs":[{"name":"tokenId","type":"uint256"},{"name":"side","type":"uint8"},{"name":"expectedEntryPrice18","type":"uint256"},{"name":"maxDeviationBps","type":"uint256"},{"name":"priceData","type":"bytes[]"}],"outputs":[]},
  {"type":"function","name":"claim","stateMutability":"nonpayable","inputs":[{"name":"tokenId","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"unstake","stateMutability":"nonpayable","inputs":[{"name":"tokenId","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"unstakeBatch","stateMutability":"nonpayable","inputs":[{"name":"epochId","type":"uint64"},{"name":"maxCount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"processPositions","stateMutability":"nonpayable","inputs":[{"name":"epochId","type":"uint64"},{"name":"maxCount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"finalizeEpoch","stateMutability":"nonpayable","inputs":[{"name":"epochId","type":"uint64"}],"outputs":[]},
  {"type":"function","name":"submitSettlementPrice","stateMutability":"payable","inputs":[{"name":"epochId","type":"uint64"},{"name":"finalPrice18","type":"uint256"},{"name":"sampleStart","type":"uint64"},{"name":"sampleEnd","type":"uint64"},{"name":"samplesHash","type":"bytes32"},{"name":"priceData","type":"bytes[]"}],"outputs":[]},
  {"type":"function","name":"createEpoch","stateMutability":"nonpayable","inputs":[],"outputs":[{"name":"epochId","type":"uint64"}]},
  {"type":"function","name":"openEntry","stateMutability":"nonpayable","inputs":[],"outputs":[]},
  {"type":"function","name":"emergencySettle","stateMutability":"nonpayable","inputs":[{"name":"epochId","type":"uint64"}],"outputs":[]},
  {"type":"function","name":"setKeeper","stateMutability":"nonpayable","inputs":[{"name":"newKeeper","type":"address"}],"outputs":[]},
  {"type":"function","name":"setTiming","stateMutability":"nonpayable","inputs":[{"name":"entryWindow_","type":"uint32"},{"name":"lockDuration_","type":"uint32"},{"name":"maxPriceAge_","type":"uint32"}],"outputs":[]},
  {"type":"function","name":"setBand","stateMutability":"nonpayable","inputs":[{"name":"bandBps_","type":"int32"}],"outputs":[]},
  {"type":"function","name":"pause","stateMutability":"nonpayable","inputs":[],"outputs":[]},
  {"type":"function","name":"unpause","stateMutability":"nonpayable","inputs":[],"outputs":[]},
  // ---- events ----
  {"type":"event","name":"EpochCreated","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"entryOpenTime","type":"uint64","indexed":false},{"name":"entryCloseTime","type":"uint64","indexed":false},{"name":"settlementTime","type":"uint64","indexed":false},{"name":"bandBps","type":"int32","indexed":false}]},
  {"type":"event","name":"Staked","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"owner","type":"address","indexed":true},{"name":"tokenId","type":"uint256","indexed":true},{"name":"side","type":"uint8","indexed":false},{"name":"entryPrice18","type":"uint256","indexed":false},{"name":"stakedCount","type":"uint32","indexed":false}]},
  {"type":"event","name":"Unstaked","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"owner","type":"address","indexed":true},{"name":"tokenId","type":"uint256","indexed":true}]},
  {"type":"event","name":"UnstakeProgressed","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"cursor","type":"uint32","indexed":false},{"name":"stakedCount","type":"uint32","indexed":false}]},
  {"type":"event","name":"AutoUnstakeFailed","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"owner","type":"address","indexed":true},{"name":"tokenId","type":"uint256","indexed":true}]},
  {"type":"event","name":"SettlementPriceSubmitted","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"finalPrice18","type":"uint256","indexed":false},{"name":"anchorPrice18","type":"uint256","indexed":false},{"name":"sampleStart","type":"uint64","indexed":false},{"name":"sampleEnd","type":"uint64","indexed":false},{"name":"samplesHash","type":"bytes32","indexed":false}]},
  {"type":"event","name":"PositionProcessed","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"tokenId","type":"uint256","indexed":true},{"name":"won","type":"bool","indexed":false},{"name":"changeBps","type":"int256","indexed":false},{"name":"feeBase","type":"uint128","indexed":false},{"name":"feeUSDC","type":"uint128","indexed":false},{"name":"contributionUsd6","type":"uint256","indexed":false}]},
  {"type":"event","name":"ProcessFailed","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"tokenId","type":"uint256","indexed":true}]},
  {"type":"event","name":"ProcessProgressed","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"cursor","type":"uint32","indexed":false},{"name":"stakedCount","type":"uint32","indexed":false}]},
  {"type":"event","name":"EpochSettled","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"finalPrice18","type":"uint256","indexed":false},{"name":"winnerCount","type":"uint32","indexed":false},{"name":"potBase","type":"uint256","indexed":false},{"name":"potUSDC","type":"uint256","indexed":false}]},
  {"type":"event","name":"RolloverInjected","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"baseIn","type":"uint256","indexed":false},{"name":"usdcIn","type":"uint256","indexed":false}]},
  {"type":"event","name":"EmptyWinnerRollover","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"potBase","type":"uint256","indexed":false},{"name":"potUSDC","type":"uint256","indexed":false}]},
  {"type":"event","name":"Claimed","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true},{"name":"owner","type":"address","indexed":true},{"name":"tokenId","type":"uint256","indexed":true},{"name":"payBase","type":"uint256","indexed":false},{"name":"payUSDC","type":"uint256","indexed":false}]},
  {"type":"event","name":"EmergencySettled","anonymous":false,"inputs":[{"name":"epochId","type":"uint64","indexed":true}]},
  // ---- errors ----
  {"type":"error","name":"NotEntryWindow","inputs":[]},
  {"type":"error","name":"EntryPriceDeviation","inputs":[]},
  {"type":"error","name":"SameBlock","inputs":[]},
  {"type":"error","name":"OneSidePerEpoch","inputs":[]},
  {"type":"error","name":"CapExceeded","inputs":[]},
  {"type":"error","name":"InsufficientLiquidity","inputs":[]},
  {"type":"error","name":"NotPool","inputs":[]},
  {"type":"error","name":"NotNPM","inputs":[]},
  {"type":"error","name":"BadSide","inputs":[]},
  {"type":"error","name":"StalePrice","inputs":[]},
  {"type":"error","name":"ZeroPrice","inputs":[]},
  {"type":"error","name":"SettleTooEarly","inputs":[]},
  {"type":"error","name":"SettlePriceTooOld","inputs":[]},
  {"type":"error","name":"SettlePriceOutOfBounds","inputs":[]},
  {"type":"error","name":"WrongPhase","inputs":[]},
  {"type":"error","name":"PrevNotSettled","inputs":[]},
  {"type":"error","name":"ProcessNotComplete","inputs":[]},
  {"type":"error","name":"NotSettled","inputs":[]},
  {"type":"error","name":"NotWinner","inputs":[]},
  {"type":"error","name":"AlreadyClaimed","inputs":[]},
  {"type":"error","name":"NothingToClaim","inputs":[]},
  {"type":"error","name":"NotOwner","inputs":[]},
  {"type":"error","name":"NotOwnerOrKeeper","inputs":[]},
  {"type":"error","name":"GraceNotElapsed","inputs":[]},
  {"type":"error","name":"RefundFailed","inputs":[]},
] as const;
