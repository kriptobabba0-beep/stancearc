// lib/errors.ts — decode FeeArena custom errors -> friendly messages for TxButton / forms.
import { BaseError, ChainMismatchError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';

/** The network name shown in wrong-network copy. Spelled out rather than imported from lib/chain:
 *  that module reads NEXT_PUBLIC_* at load, and this one is imported by plain unit tests that have
 *  no env — a display string is not worth making error formatting depend on runtime config. */
const CHAIN_NAME = 'Arc Testnet';

/** Friendly copy per FeeArena custom error name (names verbatim from the compiled artifact). */
const FRIENDLY: Record<string, string> = {
  WrongPhase: 'This action is not allowed in the current epoch phase.',
  NotEntryWindow: 'The entry window is closed — staking is only allowed during Entry Open.',
  BadSide: 'Invalid side. Choose UP, DOWN, or RANGE.',
  NotPool: 'This position is not in the Arena WETH/USDC pool or fee tier.',
  OneSidePerEpoch: 'You already staked a different side this epoch — all your stakes must share one side.',
  SameBlock: 'Only one stake action per block — please try again next block.',
  NotOwner: 'You are not the owner of this position.',
  NotSwept: 'This position has not been swept yet — settlement is still in progress.',
  AlreadyClaimed: 'This reward has already been claimed.',
  WrongSide: 'Your side did not win this epoch — no reward to claim.',
  ZeroPrice: 'No valid on-chain price yet — post a fresh Pyth update first.',
  StartPriceTooOld: 'The posted Pyth price is older than the entry-close boundary — fetch a fresh Hermes update and retry.',
  SettlePriceTooOld: 'The posted Pyth price is older than the epoch-end boundary — fetch a fresh Hermes update and retry.',
  RefundFailed: 'Could not refund the excess fee — use an account (EOA) that can receive native USDC.',
  FeeTooLow: 'The attached Pyth update fee was too low — retry.',
  BandOutOfRange: 'The configured band is invalid.',
  BadTimes: 'Invalid epoch timing configuration.',
  EpochNotEnded: 'The epoch has not reached its end time yet.',
  StalePrice: 'The oracle price is stale — it must be refreshed before this action.',
  NotSettled: 'The epoch is not settled yet — claim/unstake open only after settlement.',
  InsufficientLiquidity: 'This position has too little liquidity to stake.',
  NotNPM: 'Only genuine V3 LP positions can be staked.',
  BadSideData: 'The side encoding was invalid.',
  PrevNotSettled: 'The previous epoch must be settled before creating a new one.',
  SweepNotComplete: 'The sweep is not complete yet.',
  SweepAlreadyDone: 'The sweep is already complete.',
  AlreadyRolledOver: 'This epoch had no winner and its pot rolled forward — nothing to claim.',
  NotAllClaimed: 'All winners must claim before folding dust.',
  NothingToClaim: 'There is nothing to claim for this position.',
  StartDelayExceeded: 'The epoch start window has passed.',
  StartTooEarly: 'It is too early to start this epoch.',
  GraceNotElapsed: 'The emergency grace period has not elapsed yet.',
  ZeroAddress: 'A required address is zero.',
  BadDecimals: 'Token decimals mismatch (USDC must be 6, WETH 18).',
  RolloverAlreadyConsumed: 'Rollover has already been injected for this epoch.',
  CapExceeded: 'Stake cap reached for this epoch or user.',
  NothingToFold: 'There is no dust to fold.',
  // ── FeeArena v2 (conviction-parimutuel) custom errors (names verbatim from feeArenaV2.ts) ──
  OperatorCannotStake: 'This wallet is the keeper/owner and cannot stake — use a separate wallet.',
  ConvOutOfBounds: 'Your conviction is outside the allowed [min, max] range for this market.',
  MissingConviction: 'A conviction amount is required to stake in this arena.',
  SideOverConcentrated: 'This side is over-concentrated — your conviction would exceed the per-side cap.',
  NotRefundable: 'This position is not refundable — only winning-side conviction can be reclaimed.',
  AlreadyRefunded: 'This conviction has already been refunded.',
  SubsidyCapExceeded: 'The per-epoch subsidy cap would be exceeded.',
  WideConfidence: 'The oracle price confidence is too wide to settle — wait for a tighter update.',
  StagedSideMismatch: 'The staged side does not match — all your stakes this epoch must share one side.',
  NothingCredited: 'You have no deferred (credited) balance to withdraw.',
};

/** Deepest non-empty message in an error's `cause` chain (skips the top error itself). */
function deepestCauseMessage(err: unknown): string | undefined {
  let cur: unknown = (err as { cause?: unknown })?.cause;
  let deepest: string | undefined;
  // Guard against pathological/cyclic chains.
  for (let i = 0; i < 16 && cur != null; i++) {
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim() !== '') deepest = msg.trim();
    cur = (cur as { cause?: unknown }).cause;
  }
  return deepest;
}

/** Turn any thrown error (write/simulate) into a short, user-facing string. NEVER returns blank —
 *  a blank string renders as NOTHING in `{error && …}` UI, which is worse than a vague message. */
export function friendlyError(err: unknown): string {
  const msg = friendlyErrorInner(err);
  return msg.trim() !== '' ? msg : REVERT_NO_REASON;
}

/** Shown when the failure carries no readable reason at all. Rare — most revert paths do produce a
 *  message (viem's `call` throws a populated CallExecutionError, and wagmi's revert branch falls back
 *  to "unknown reason"). But a blank message is not impossible, and blank renders as NOTHING in
 *  `{error && …}` UI, so the guard exists to make silence structurally unreachable. */
export const REVERT_NO_REASON =
  'The transaction reverted without a readable reason (often a custom contract error — check the transaction on the explorer).';

function friendlyErrorInner(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return 'Transaction rejected in wallet.';
    // Every Arc write pins its chain (see withGasFloor), so viem refuses to sign when the wallet is
    // pointed somewhere else. That refusal is the safe outcome — it used to sign on whatever network
    // was selected — but viem's own wording is about chain ids, so say what to do instead.
    if (err.walk((e) => e instanceof ChainMismatchError)) {
      return `Your wallet is on the wrong network. Switch it to ${CHAIN_NAME} and try again.`;
    }
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name && FRIENDLY[name]) return FRIENDLY[name];
      if (reverted.reason) return reverted.reason;
    }

    // Generic path (the "An unknown RPC error occurred" family): shortMessage alone is opaque and hides
    // the real reason (e.g. "execution reverted: ERC20: transfer amount exceeds balance"). Surface the
    // underlying cause: prefer viem's `details` (it resolves the explicit details OR the cause message),
    // else walk the cause chain to its deepest message. Append it so the user sees WHY, not just "unknown".
    const short = err.shortMessage ?? err.message;
    const detail = (err.details && err.details.trim() !== '' ? err.details.trim() : undefined) ??
      deepestCauseMessage(err);
    if (detail && !short.includes(detail)) return `${short} — ${detail}`;
    return short;
  }
  if (err instanceof Error) return err.message;
  return 'Transaction failed.';
}
