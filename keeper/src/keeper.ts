// keeper.ts - the per-market crank. runMarketOnce() reads the market's current epoch,
// asks the PURE decideAction() what to do, and executes AT MOST ONE action this tick,
// awaiting the receipt before returning. One action per market per tick keeps the
// single keeper key nonce-safe (no overlapping in-flight txs).
//
// START/END post a FRESH Pyth update from Hermes and pay the exact getUpdateFee as
// `value` (excess is refunded by Pyth). Every write sets maxFeePerGas to the Arc gas
// floor (~20 gwei) so writes are never under-priced. All errors are caught and logged;
// this never throws out of the tick loop.
import {
  BaseError,
  ContractFunctionRevertedError,
  WaitForTransactionReceiptTimeoutError,
  type Abi,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from 'viem';
import { feeArenaAbi, feeArenaV2Abi, erc20Abi, pythAbi } from './abi.js';
import { fetchPythUpdate, fetchPythUpdateMulti } from './hermes.js';
import { escalatedGas, totalAttempts } from './gasEscalation.js';
import { classifyRevert, type RevertInfo } from './revertDecode.js';
import { type SpendGuard, SpendCapTrippedError } from './spendGuard.js';
import {
  decideAction,
  decideRecovery,
  EMERGENCY_RESOLUTION_RANGE,
  PhaseView,
  type Action,
  type KeeperState,
} from './decide.js';
import { collapseV2Phase, decidePinnedWindow, effectiveSettleWindow } from './decideV2.js';
import type { KeeperConfig, MarketConfig } from './config.js';

/** The arena ABI for a market, selected by its configured version. */
function arenaAbiFor(market: MarketConfig): Abi {
  return market.version === 'v2' ? (feeArenaV2Abi as unknown as Abi) : (feeArenaAbi as unknown as Abi);
}

/**
 * The 4-byte selector of FeeArena's `SweepAlreadyDone()` custom error
 * (keccak256("SweepAlreadyDone()")[:4]). The contract reverts this when sweep() is
 * called on an epoch whose internal phase is ALREADY Swept (or Settled). Both
 * src/FeeArena.sol and src/FeeArenaV2.sol declare + revert it, and both keeper ABIs
 * (feeArenaAbi / feeArenaV2Abi) now declare it so viem can decode it to errorName.
 */
export const SWEEP_ALREADY_DONE_SELECTOR = '0x562d6d1b';

/**
 * The raw 4 selector bytes (0x56,0x2d,0x6d,0x1b) of SweepAlreadyDone() rendered as a Latin-1
 * string - i.e. String.fromCharCode(0x56,0x2d,0x6d,0x1b) === 'V-m\x1b'. The Arc RPC's
 * eth_call/eth_estimateGas error path returns the revert payload as a "reason" STRING, and viem
 * Latin-1-decodes those 4 bytes into this control-char sequence INSIDE err.message / err.details
 * (e.g. "Execution reverted with reason: V-m\x1b"). The literal hex "0x562d6d1b" is NOT present
 * in that message (only the calldata hex is), so a plain msg.includes('0x562d6d1b') misses the
 * LIVE shape - this exact 4-byte control sequence is the distinctive fingerprint for it. The
 * trailing 0x1b (ESC) makes it impossible to occur by accident in a normal revert string.
 */
const SWEEP_ALREADY_DONE_RAW_BYTES = String.fromCharCode(0x56, 0x2d, 0x6d, 0x1b); // 'V-m\x1b'

/**
 * Recursively scan an error and its entire `.cause` chain (including plain non-Error RPC objects
 * that BaseError.walk() can't traverse into) for a hex string field - `.data` or `.signature` -
 * that carries the SweepAlreadyDone selector. On the Arc raw-eth_call path the selector survives
 * ONLY as the innermost RPC error's `.data === '0x562d6d1b'`; on the undecoded-ABI simulate/estimate
 * path it survives as a ContractFunctionRevertedError's `.signature === '0x562d6d1b'`. Bounded
 * depth so a cyclic cause chain can't loop forever. Pure: no I/O.
 */
function rawRevertDataHasSelector(err: unknown, depth = 0): boolean {
  if (err == null || typeof err !== 'object' || depth > 12) return false;
  const o = err as Record<string, unknown>;
  for (const key of ['data', 'signature', 'raw'] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.toLowerCase().startsWith(SWEEP_ALREADY_DONE_SELECTOR)) {
      return true;
    }
  }
  // descend the cause chain (viem nests RpcRequestError.cause = raw {code,message,data} object)
  return rawRevertDataHasSelector(o.cause, depth + 1);
}

/**
 * Robustly detect a `SweepAlreadyDone()` revert from a thrown viem error, across EVERY shape the
 * live Arc RPC actually produces (verified by hitting the wedged v1 arena epoch 80). Three
 * signals in priority order; any one is sufficient:
 *
 *   (a) viem DECODED it: a ContractFunctionRevertedError anywhere in the cause chain whose
 *       `data.errorName === 'SweepAlreadyDone'`. This is the clean path - both keeper ABIs declare
 *       the error, so simulate/estimate with the keeper's own ABI decode to errorName.
 *
 *   (b) the raw selector survives as STRUCTURED revert DATA: a `.data` / `.signature` hex string
 *       (anywhere in the .cause chain, including the innermost non-Error RPC object) that
 *       startsWith 0x562d6d1b. This is the LIVE eth_call shape: viem's CallExecutionError ->
 *       ExecutionRevertedError -> RpcRequestError -> {data:'0x562d6d1b'} - the only place the
 *       selector survives uncorrupted (the message Latin-1-mangles it; see below). It also covers
 *       the undecoded-ABI simulate/estimate shape (ContractFunctionRevertedError.signature).
 *
 *   (c) LAST-RESORT message fallback, matching BOTH renderings of the selector in the text:
 *       - the literal hex '0x562d6d1b' (undecoded-ABI simulate/estimate message), AND
 *       - the raw 4 selector bytes Latin-1-rendered as 'V-m\x1b' (the LIVE raw-eth_call message
 *         "Execution reverted with reason: V-m\x1b", where the hex is NOT present).
 *
 * Conservative by construction: it ONLY ever matches this exact selector - never a broad
 * "reverted" match - so it can't swallow an unrelated revert. SweepAlreadyDone is UNAMBIGUOUS
 * ("the sweep for this epoch is ALREADY complete"), so converting it to a benign "mark swept +
 * finalize next tick" recovery is always safe. Pure: no I/O.
 */
export function isSweepAlreadyDone(err: unknown): boolean {
  // (a) viem DECODED it - walk the cause chain for a ContractFunctionRevertedError whose errorName
  // resolved to 'SweepAlreadyDone' (works because both keeper ABIs declare the error).
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (
      reverted instanceof ContractFunctionRevertedError &&
      reverted.data?.errorName === 'SweepAlreadyDone'
    ) {
      return true;
    }
  }
  // (b) raw selector in STRUCTURED revert data (.data / .signature) anywhere in the cause chain.
  // This is where the selector lives on the LIVE raw-eth_call path (innermost RPC object .data),
  // and on the undecoded-ABI simulate/estimate path (.signature).
  if (rawRevertDataHasSelector(err)) return true;
  // (c) LAST-RESORT message fallback: the literal hex OR the Latin-1 raw-byte rendering 'V-m\x1b'.
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return lower.includes(SWEEP_ALREADY_DONE_SELECTOR) || msg.includes(SWEEP_ALREADY_DONE_RAW_BYTES);
}

/** Structured single-line log record for one market tick. The action union covers v1/v2
 *  (`Action`) plus the v3 entry-anchored cranks (SETTLE/PROCESS - see decideV3.ts). */
export interface TickLog {
  ts: string;
  market: string;
  epochId: string;
  phase: string;
  action: Action | 'SETTLE' | 'PROCESS' | 'FINALIZE' | 'UNSTAKE' | 'RECOVER';
  txHash?: string;
  swept?: string;
  /** v1 auto-return progress note for an UNSTAKE tick: "done->~next/total (epoch N)". */
  unstaked?: string;
  error?: string;
  /**
   * Set to the epochId (as bigint) when this tick executed a SWEEP successfully
   * (action==='SWEEP' and no error). The loop uses this to update lastSweptEpochId
   * in the per-market runtime so subsequent ticks know the empty-epoch sweep is done.
   */
  sweptEpochId?: bigint;
  /**
   * Set to the epochId (as bigint) when this tick FIRED the optional owner-key
   * wedge recovery (emergencySettle) SUCCESSFULLY. Purely observational - lets the
   * loop/operator see that a wedge was auto-cleared (the txHash is in `txHash`).
   * Only ever set when KEEPER_OWNER_PRIVATE_KEY is configured.
   */
  recoveredEpochId?: bigint;
  /**
   * v2 ONLY - set when a START/END action was DEFERRED because the block time is not yet
   * inside the contract's pinned publishTime window ('WAIT', too early) or has fallen past
   * the safe tail of it ('MISSED'). On 'WAIT' the tick is a NO-OP success (re-check soon);
   * on 'MISSED' it is recorded as a failure so the breaker backs off and a repeatedly-missed
   * window pages the operator (the epoch would otherwise wedge -> owner emergencySettle).
   */
  windowState?: 'WAIT' | 'MISSED';
  /**
   * v2 ONLY - set to the epochId (as bigint) when this tick funded the OPTIONAL per-epoch
   * subsidy via the owner key's fundSubsidy. Purely observational.
   */
  fundedSubsidyEpochId?: bigint;
  /** Native wei this tick's broadcast actually spent (mined success OR revert). 0 / unset when
   *  the crank was sim-skipped, freshness-deferred, or did nothing. Booked into the spend cap. */
  gasSpentWei?: bigint;
  /** Classified revert reason when a crank was caught by pre-flight simulation (e.g. 'StalePrice'
   *  / 'WrongPhase'). Lets the loop apply the StalePrice-specific backoff + a precise alert. */
  revertReason?: string;
  /** True when the crank was SKIPPED before broadcast by the simulate gate - ZERO gas burned
   *  (the doomed crank that used to mine+revert and drain the signer). */
  simSkipped?: boolean;
  /** True when the keeper-side freshness gate DEFERRED a SETTLE because the on-chain maxPriceAge is
   *  too tight vs mine latency for any price to survive to the mine block (don't burn - alert). */
  freshnessDeferred?: boolean;
  /** Set to the trip reason ('hour-cap' / 'burst-cap') when the persisted spend cap is OPEN - the
   *  loop must STOP all cranking until an operator clears the ledger. */
  spendCapTripped?: string;
  /** v3 pipeline - how many settlement-pipeline actions this tick chained AFTER the first one
   *  (SETTLE -> PROCESS -> ... -> OPEN back-to-back). Absent on legacy one-action ticks. */
  chainedActions?: number;
  /** v3 pipeline - loop hint: ms until this market next needs attention (the pre-sample start or
   *  the settlement moment). The loop shortens its end-of-pass sleep to the smallest hint so a
   *  boundary crank fires within ~2s instead of up to a full poll late. Absent when nothing is near. */
  nextWakeMsHint?: number;
}

const PHASE_NAME: Record<number, string> = {
  [PhaseView.Idle]: 'Idle',
  [PhaseView.EntryOpen]: 'EntryOpen',
  [PhaseView.Running]: 'Running',
  [PhaseView.Settled]: 'Settled',
};

/** Emit a structured log line (single JSON object per line - easy to grep/ship). */
export function logTick(rec: TickLog): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(rec, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  ));
}

/** Emit a one-off structured log line (bigint-safe) - used for gas-escalation notices. */
function logLine(o: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** The contract-call fields a single write supplies (everything except the gas-PRICE overrides). */
interface WriteFields {
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /**
   * Optional EXPLICIT gas-limit. When set, simulate + writeContract use it verbatim instead of
   * letting viem run eth_estimateGas - the v3 position cranks pass a value clamped to the RPC's
   * per-tx cap so a heavy batch can never trip the cap (the wedge) on the estimate or the send.
   */
  gas?: bigint;
}

/**
 * A doomed crank caught by PRE-FLIGHT SIMULATION - carries the classified revert reason. NO
 * transaction was broadcast, so NO gas was burned. The caller records it as a tick failure (the
 * normal backoff path) and, for a StalePrice reason, applies the freshness-specific backoff.
 */
export class WouldRevertError extends Error {
  constructor(public readonly info: RevertInfo, cause?: unknown) {
    super(`crank would revert (${info.name}) - skipped before broadcast`);
    this.name = 'WouldRevertError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Optional controls for a write: the pre-flight simulate gate + the persisted spend
 * circuit-breaker. Omitted by the arb/swap/staker paths and by unit tests, so behavior there is
 * EXACTLY as before; the lifecycle loop (index.ts) always supplies them for the keeper key.
 */
export interface SendControls {
  /** Simulate before broadcasting so a doomed crank never mines+reverts (zero gas burned). */
  simulate: boolean;
  /** Persisted spend cap. status() is checked before EACH broadcast; book() after each one. */
  guard?: SpendGuard;
  /** Worst-case gas units for the spend estimate when a timeout leaves no receipt to read. */
  fallbackGasLimit: bigint;
  /** Clock for the guard (defaults to Date.now); injected only in tests. */
  now?: () => number;
}

/** True when a thrown error is an on-chain REVERT (would burn gas) vs an RPC/transport error. */
function isRevertError(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError)) {
    return true;
  }
  // classifyRevert also catches the raw-RPC selector shape that BaseError.walk can't descend into.
  return classifyRevert(err).name !== 'unknown';
}

/** Native wei a mined tx actually spent: gasUsed * effectiveGasPrice (falls back to the bid). */
function receiptSpendWei(
  receipt: { gasUsed?: bigint; effectiveGasPrice?: bigint },
  fallbackPriceWei: bigint,
): bigint {
  const used = receipt.gasUsed ?? 0n;
  const price = receipt.effectiveGasPrice ?? fallbackPriceWei;
  return used * price;
}

/**
 * TASK 4b + drain-elimination - send a write with PRE-FLIGHT SIMULATION, a persisted SPEND CAP,
 * BOUNDED gas-tip escalation, and honest gas accounting.
 *
 * 1. PRE-FLIGHT (when `send.simulate`): simulate the call FIRST. If it would revert, throw a
 *    WouldRevertError WITHOUT broadcasting - a doomed crank now costs ZERO gas instead of a full
 *    mined-revert burn (the original drain). A non-revert sim error (RPC/transport) is best-effort:
 *    we log and broadcast anyway so a flaky sim RPC never wedges a legitimate crank.
 * 2. SPEND CAP (when `send.guard`): checked IMMEDIATELY before each broadcast (not once per sweep,
 *    so a batch can't overshoot) - a tripped cap throws SpendCapTrippedError, halting the keeper.
 * 3. ESCALATION: attempt 0 prices at the floor (unchanged). The receipt is awaited with
 *    `cfg.receiptTimeoutMs`:
 *      - resolves (success OR mined-revert) -> book the ACTUAL gas spent + return it (a revert is
 *        NOT escalated - bidding more won't un-revert a doomed crank);
 *      - TIMES OUT with attempts left -> re-send the SAME tx at the next (capped) tip (viem fetches
 *        the pending nonce, so the higher-priced resend REPLACES it);
 *      - TIMES OUT with no attempts left -> book a WORST-CASE estimate (a late-mining tx must not
 *        evade the cap) and rethrow so the caller records the tick as a FAILURE.
 * Returns the landed txHash + receipt + the native wei it spent.
 */
export async function sendWriteWithEscalation(
  client: PublicClient,
  wallet: WalletClient,
  base: { address: `0x${string}`; abi: Abi; account: Account; chain: Chain },
  fields: WriteFields,
  cfg: KeeperConfig,
  ctx: { market: string; action: string },
  onSent?: (hash: `0x${string}`) => void,
  send?: SendControls,
): Promise<{ txHash: `0x${string}`; receipt: { status: 'success' | 'reverted' }; gasSpentWei: bigint }> {
  const nowFn = send?.now ?? Date.now;

  // (1) PRE-FLIGHT SIMULATION - block a doomed crank before it can mine+revert (zero gas). We
  // simulate at the attempt-0 (floor) gas; the request's estimated gas (when viem returns it)
  // doubles as the worst-case spend estimate for a later timeout.
  let simGas: bigint | undefined;
  if (send?.simulate) {
    try {
      const sim = await client.simulateContract({
        ...base,
        ...escalatedGas(0, cfg.gasEscalation),
        functionName: fields.functionName,
        ...(fields.args !== undefined ? { args: fields.args } : {}),
        ...(fields.value !== undefined ? { value: fields.value } : {}),
        // Explicit gas-limit (when supplied) makes the sim an eth_call at exactly that gas -
        // no internal estimateGas to trip the RPC cap, and it doubles as the worst-case spend.
        ...(fields.gas !== undefined ? { gas: fields.gas } : {}),
      } as Parameters<PublicClient['simulateContract']>[0]);
      const reqGas = (sim as { request?: { gas?: bigint } }).request?.gas;
      if (typeof reqGas === 'bigint') simGas = reqGas;
    } catch (simErr) {
      if (isRevertError(simErr)) {
        // Doomed - the contract would revert. Don't broadcast; surface the classified reason.
        throw new WouldRevertError(classifyRevert(simErr), simErr);
      }
      // Best-effort gate: a non-revert sim failure (RPC/transport blip) must not stop a legit
      // crank - log it and fall through to broadcast.
      logLine({ msg: 'keeper.sim.skip', market: ctx.market, action: ctx.action, error: simErr instanceof Error ? simErr.message : String(simErr) });
    }
  }

  const attempts = totalAttempts(cfg.gasEscalation);
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const gas = escalatedGas(attempt, cfg.gasEscalation);

    // (2) SPEND CAP - check right before the broadcast so the cap can't be overshot by a whole
    // batch of sends. A tripped cap halts the keeper (the loop catches this + stops cranking).
    if (send?.guard) {
      const s = send.guard.status(nowFn());
      if (s.tripped) throw new SpendCapTrippedError(s.reason);
    }

    if (attempt > 0) {
      logLine({
        msg: 'keeper.gas.escalate',
        market: ctx.market,
        action: ctx.action,
        attempt,
        ofAttempts: attempts - 1,
        maxFeePerGas: gas.maxFeePerGas,
        reason: 'prior send receipt-wait timed out (tx stuck/under-priced)',
      });
    }
    const txHash = (await wallet.writeContract({
      ...base,
      ...gas,
      functionName: fields.functionName,
      ...(fields.args !== undefined ? { args: fields.args } : {}),
      ...(fields.value !== undefined ? { value: fields.value } : {}),
      // Explicit gas-limit (when supplied) bypasses viem's estimateGas + its buffer - essential
      // for a crank whose true cost sits just under the cap (estimate*buffer would exceed it).
      ...(fields.gas !== undefined ? { gas: fields.gas } : {}),
    } as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
    onSent?.(txHash);
    try {
      const receipt = (await client.waitForTransactionReceipt({
        hash: txHash,
        timeout: cfg.receiptTimeoutMs,
      })) as { status: 'success' | 'reverted'; gasUsed?: bigint; effectiveGasPrice?: bigint };
      // Book the ACTUAL gas this tx burned (success OR mined-revert both spend) before returning.
      const gasSpentWei = receiptSpendWei(receipt, gas.maxFeePerGas);
      send?.guard?.book(nowFn(), gasSpentWei);
      return { txHash, receipt, gasSpentWei };
    } catch (err) {
      lastErr = err;
      // Only a receipt-wait TIMEOUT warrants an escalated re-send. Any other error
      // (RPC failure, malformed tx) is terminal - rethrow immediately.
      if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err;
      // Timeout with attempts left -> loop re-sends a REPLACEMENT (its receipt/timeout is booked).
      // Final timeout -> the tx may STILL mine out-of-band, so book a worst-case estimate now so a
      // late-landing tx can't evade the cap, then rethrow for the outer failure/backoff path.
      if (attempt === attempts - 1) {
        send?.guard?.book(nowFn(), (simGas ?? send.fallbackGasLimit) * gas.maxFeePerGas);
        throw err;
      }
    }
  }
  // Unreachable (the loop either returns or rethrows), but satisfies the type checker.
  throw lastErr instanceof Error ? lastErr : new Error('gas escalation exhausted');
}

/**
 * The on-chain state slice decideAction needs, read from currentEpoch()/currentEpochId().
 * ABI is selected per market version so the (different-shaped) EpochV2 tuple decodes
 * correctly for v2; the keeper reads the SAME named fields from both (phase, entryCloseTime,
 * startTime, endTime, settlePrice18, sweepCursor, stakedCount).
 *
 * For a v2 market it ALSO reads `settleWindow` (the contract pin width) so the pinned-window
 * timing logic can bound the attempt - returned via the second tuple element (undefined for v1).
 */
async function readState(
  client: PublicClient,
  market: MarketConfig,
  nowSec: bigint,
  lastSweptEpochId: bigint | null,
): Promise<{ state: KeeperState; settleWindow: bigint | undefined }> {
  const arena = market.arena;
  const abi = arenaAbiFor(market);
  const isV2 = market.version === 'v2';
  // maxStartDelay + paused are plain getters (NOT in EpochView) - read alongside the
  // epoch so decideAction can bound the start window and skip cranks while paused. For v2,
  // settleWindow is read too (the pin width) - a single extra batched read.
  const reads = [
    client.readContract({ address: arena, abi, functionName: 'currentEpochId' }),
    client.readContract({ address: arena, abi, functionName: 'currentEpoch' }),
    client.readContract({ address: arena, abi, functionName: 'maxStartDelay' }),
    client.readContract({ address: arena, abi, functionName: 'paused' }),
    ...(isV2 ? [client.readContract({ address: arena, abi, functionName: 'settleWindow' })] : []),
  ] as const;
  const results = await Promise.all(reads);
  const currentEpochId = results[0] as bigint;
  const epoch = results[1] as {
    phase: number | bigint;
    entryCloseTime: bigint;
    startTime: bigint;
    endTime: bigint;
    settlePrice18: bigint;
    sweepCursor: number;
    stakedCount: number;
  };
  const maxStartDelay = results[2] as number | bigint;
  const paused = results[3] as boolean;
  const settleWindow = isV2 ? BigInt(results[4] as number | bigint) : undefined;

  // v1 AUTO-RETURN backlog: the most recently Settled epoch + its on-chain unstake
  // cursor. Two dependent reads (progress needs the epochId), v1 only - v2 has no
  // unstakeBatch, so the fields stay undefined and decideAction never picks UNSTAKE.
  // BEST-EFFORT by design: auto-return is a convenience crank, so a failed read here
  // (RPC blip, or an OLD v1 arena predating unstakeProgress) leaves the fields
  // undefined - no backlog, lifecycle decisions unchanged - instead of failing the tick.
  let lastSettledEpochId: bigint | undefined;
  let unstakeDone: number | undefined;
  let unstakeTotal: number | undefined;
  if (!isV2) {
    try {
      lastSettledEpochId = (await client.readContract({
        address: arena,
        abi,
        functionName: 'lastSettledEpochId',
      })) as bigint;
      if (lastSettledEpochId !== 0n && lastSettledEpochId !== undefined) {
        // No dedicated unstakeProgress view on-chain (EIP-170 size pressure): the pair is
        // (unstakeCursor(id), sweepProgress(id).total) - total == the epoch's stakedCount.
        const [cursor, sweepPair] = await Promise.all([
          client.readContract({
            address: arena,
            abi,
            functionName: 'unstakeCursor',
            args: [lastSettledEpochId],
          }),
          client.readContract({
            address: arena,
            abi,
            functionName: 'sweepProgress',
            args: [lastSettledEpochId],
          }),
        ]);
        unstakeDone = Number(cursor as number | bigint);
        unstakeTotal = Number((sweepPair as readonly [number, number])[1]);
      }
    } catch {
      lastSettledEpochId = undefined;
      unstakeDone = undefined;
      unstakeTotal = undefined;
    }
  }

  // CRITICAL - PHASE-ENUM COLLAPSE. v1's currentEpoch() runs EpochViewLib.toView/collapse, so it
  // ALREADY returns the external 4-phase PhaseView (Idle=0/EntryOpen=1/Running=2/Settled=3) -
  // use it as-is. v2's currentEpoch() returns the RAW EpochV2 struct with the INTERNAL 6-phase
  // Phase enum (None=0/EntryOpen=1/Running=2/Resolved=3/Swept=4/Settled=5) and does NOT collapse,
  // so we MUST collapse it here (mirroring EpochViewLib.collapse) before decideAction. Without
  // this a v2 Resolved(3) reads as PhaseView.Settled -> CREATE -> reverts (winners never paid),
  // Swept(4)/Settled(5) -> NONE -> the lifecycle wedges at first settle. Do NOT collapse v1.
  const phase = isV2 ? collapseV2Phase(Number(epoch.phase)) : (Number(epoch.phase) as PhaseView);

  const state: KeeperState = {
    currentEpochId,
    phase,
    entryCloseTime: epoch.entryCloseTime,
    startTime: epoch.startTime,
    endTime: epoch.endTime,
    settlePrice18: epoch.settlePrice18,
    sweepCursor: epoch.sweepCursor,
    stakedCount: epoch.stakedCount,
    nowSec,
    maxStartDelay: BigInt(maxStartDelay),
    paused,
    lastSweptEpochId,
    lastSettledEpochId,
    unstakeDone,
    unstakeTotal,
  };
  return { state, settleWindow };
}

/**
 * Run a single tick for one market: read -> decide -> execute one action (awaiting
 * the receipt). Returns the structured log record (also emitted via logTick). Never
 * throws: any failure is captured into the record's `error` field.
 *
 * @param lastSweptEpochId - The epochId for which sweep() was last confirmed
 *   successful for this market (from MarketRuntime). Used by decideAction to handle
 *   empty epochs correctly. Pass null if no sweep has been confirmed yet.
 * @param owner - OPTIONAL owner signer for wedge auto-recovery. When provided AND
 *   the epoch is genuinely wedged (action==='STUCK') AND the on-chain GRACE window
 *   has elapsed, the keeper calls the onlyOwner `emergencySettle(epochId, RANGE)`
 *   with THIS separate wallet to self-heal, then resumes normal cranking on the next
 *   tick. When undefined, the wedge surfaces as STUCK exactly as before (unchanged).
 *   The owner key is used SOLELY for emergencySettle - every normal crank
 *   (create/open/start/end/sweep/finalize) still uses the default keeper `account`.
 *   TESTNET convenience only - see decide.ts / README for the mainnet caveat.
 */
export async function runMarketOnce(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chain: Chain,
  market: MarketConfig,
  cfg: KeeperConfig,
  lastSweptEpochId: bigint | null = null,
  owner?: { wallet: WalletClient; account: Account },
  send?: SendControls,
): Promise<TickLog> {
  const rec: TickLog = {
    ts: new Date().toISOString(),
    market: market.id,
    epochId: '?',
    phase: '?',
    action: 'NONE',
  };

  const abi = arenaAbiFor(market);
  const isV2 = market.version === 'v2';
  // The owner-key cranks (emergencySettle recovery, subsidy) draw on the SEPARATE owner reserve,
  // not the keeper signer, so they get the simulate gate but NOT the keeper's spend cap.
  const sendOwner: SendControls | undefined = send ? { ...send, guard: undefined } : undefined;

  try {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const { state, settleWindow } = await readState(client, market, nowSec, lastSweptEpochId);
    rec.epochId = state.currentEpochId.toString();
    rec.phase = PHASE_NAME[state.phase] ?? `Unknown(${state.phase})`;

    const action = decideAction(state);
    rec.action = action;
    if (action === 'NONE') {
      // v2 ONLY - even with no lifecycle action this tick, the OPTIONAL per-epoch subsidy may
      // still need funding (e.g. EntryOpen before entry closes). Try it, then return.
      await maybeFundSubsidy(client, market, cfg, state, owner, rec, chain);
      logTick(rec);
      return rec;
    }

    // STUCK: the start window was missed (now > entryCloseTime + maxStartDelay), so
    // startEpoch would revert StartDelayExceeded forever. The keeper key cannot clear
    // this - the only exit is the onlyOwner emergencySettle.
    if (action === 'STUCK') {
      // OPTIONAL owner-key auto-recovery. With NO owner key configured, behavior is
      // UNCHANGED: surface loudly as a failure, send NO tx, let the loop back off and
      // the operator's emergencySettle/rotation clear it.
      const recovery = decideRecovery(state, owner !== undefined);

      if (recovery === 'NONE') {
        rec.error =
          'epoch wedged: start window missed - owner must emergencySettle / rotate keeper';
        logTick(rec);
        return rec;
      }

      if (recovery === 'WAIT_GRACE') {
        // Genuinely wedged + owner key present, but the on-chain GRACE window has not
        // elapsed (emergencySettle would revert GraceNotElapsed). Do NOT spam it - record
        // a failure so the per-market backoff throttles retries, and try again later.
        rec.error =
          'epoch wedged: owner recovery armed but GRACE not yet elapsed (endTime + GRACE) - backing off, will retry';
        logTick(rec);
        return rec;
      }

      // recovery === 'RECOVER': genuinely wedged, grace elapsed, owner key present.
      // Self-heal by calling the onlyOwner emergencySettle(epochId, RANGE) with the
      // SEPARATE owner wallet (never the keeper key). Next tick resumes normal cranking
      // (the cleared epoch -> Settled -> CREATE). Priced at the Arc gas floor on attempt 0
      // (unchanged) with the SAME bounded escalation as every other write, so a congestion
      // spike can't leave the recovery tx stuck and the wedge uncleared.
      const ownerSigner = owner!; // RECOVER implies owner !== undefined (decideRecovery gate)
      const { txHash: recoverTx, receipt: recoverReceipt } = await sendWriteWithEscalation(
        client,
        ownerSigner.wallet,
        { address: market.arena, abi, account: ownerSigner.account, chain },
        { functionName: 'emergencySettle', args: [state.currentEpochId, EMERGENCY_RESOLUTION_RANGE] },
        cfg,
        { market: market.id, action: 'RECOVER' },
        undefined,
        sendOwner,
      );
      rec.txHash = recoverTx;
      if (recoverReceipt.status !== 'success') {
        // Mined-but-reverted (e.g. a borderline GraceNotElapsed due to chain-vs-local clock
        // skew, or a race with a manual settle). Treat as a failure so the loop backs off
        // and retries - never as a cleared wedge.
        rec.error = `owner recovery emergencySettle reverted for epoch ${state.currentEpochId}`;
        logTick(rec);
        return rec;
      }
      // Recovery succeeded - the wedge is cleared. Loud, explicit log: epochId + tx hash.
      rec.recoveredEpochId = state.currentEpochId;
      logTick(rec);
      return rec;
    }

    // v2 ONLY - before a START/END, the OPTIONAL subsidy can still be funded (phase < Resolved
    // covers EntryOpen at START time and Running at END time). Fund first so external value is
    // committed even if the pinned-window attempt below has to defer to a later tick.
    await maybeFundSubsidy(client, market, cfg, state, owner, rec, chain);

    // v2 ONLY - PINNED-WINDOW GATE for START/END. The contract forces the posted blob's
    // publishTime into [endpointTime, endpointTime+settleWindow]; a post outside it reverts
    // (parsePriceFeedUpdates PriceFeedNotFoundWithinRange). decidePinnedWindow says whether
    // NOW is a safe instant to fetch+post:
    //   - 'WAIT'    -> endpoint not reached yet: no-op success, re-check on a fast sub-window tick.
    //   - 'MISSED'  -> past the safe tail: record a FAILURE so the breaker backs off + a
    //                  repeatedly-missed window pages the operator (else the epoch wedges).
    //   - 'ATTEMPT' -> fetch a fresh blob + post; an out-of-window revert is handled like any
    //                  mined-revert (tick FAILURE -> retry next tick with a fresher blob).
    // v1 markets never enter this branch (they post on any fresh blob once the endpoint passes).
    if (isV2 && (action === 'START' || action === 'END')) {
      const endpointTime = action === 'START' ? state.startTime : state.endTime;
      const win = effectiveSettleWindow(settleWindow ?? 0n);
      const decision = decidePinnedWindow({
        nowSec: state.nowSec,
        endpointTime,
        settleWindow: win,
        safetyMarginSec: cfg.v2WindowMarginSec,
      });
      if (decision === 'WAIT') {
        rec.windowState = 'WAIT';
        logTick(rec);
        return rec; // not yet inside the window - no-op success
      }
      if (decision === 'MISSED') {
        rec.windowState = 'MISSED';
        rec.error = `v2 pinned ${action} window missed: now=${state.nowSec} not in [${endpointTime}, ${endpointTime + win}] (margin ${cfg.v2WindowMarginSec}s) - will retry with a fresher blob; repeated misses wedge -> owner emergencySettle`;
        logTick(rec);
        return rec; // failure -> backoff + (on repeat) WEDGED alert
      }
      // decision === 'ATTEMPT' -> fall through to fetch + post below.
    }

    // Base write target (gas overrides are now applied PER ATTEMPT by the escalation helper,
    // which prices attempt 0 at the Arc floor - unchanged - and bumps a stuck tx's tip up to
    // the cap on a receipt-wait timeout so a congestion spike can't wedge a crank's window).
    const base = { address: market.arena, abi, account, chain } as const;

    // Each action contributes only its function-specific fields; the helper handles gas +
    // escalation + the bounded receipt wait. A START/END additionally fetches a fresh Pyth
    // update + its fee (paid as `value`). For v2 the same (bytes[]) startEpoch/endEpoch are
    // posted - the contract pins the publishTime window internally (decidePinnedWindow above
    // ensures the freshly-fetched blob lands inside it).
    let fields: WriteFields | undefined;

    switch (action) {
      case 'CREATE':
        fields = { functionName: 'createEpoch' };
        break;

      case 'OPEN':
        fields = { functionName: 'openEntry' };
        break;

      case 'START': {
        const { priceData, fee } = await fetchUpdateAndFee(client, cfg, market.feedId);
        fields = { functionName: 'startEpoch', args: [priceData], value: fee };
        break;
      }

      case 'END': {
        // Fresh update so publishTime >= endTime (capture-pinning).
        const { priceData, fee } = await fetchUpdateAndFee(client, cfg, market.feedId);
        fields = { functionName: 'endEpoch', args: [priceData], value: fee };
        break;
      }

      case 'SWEEP':
        // One batch per tick: bounded gas + nonce-safe. Subsequent ticks advance the
        // cursor until cursor==stakedCount, after which decideAction yields FINALIZE.
        fields = { functionName: 'sweep', args: [BigInt(cfg.sweepBatch)] };
        rec.swept = `${state.sweepCursor}->~${Math.min(state.sweepCursor + cfg.sweepBatch, state.stakedCount)}/${state.stakedCount}`;
        break;

      case 'FINALIZE':
        fields = { functionName: 'finalizeSettle' };
        break;

      case 'UNSTAKE': {
        // v1 AUTO-RETURN: push one bounded batch of the settled epoch's NFTs back to
        // their owners. Permissionless + cursor-resumable on-chain; a parked (reverting)
        // receiver is skipped by the contract and never retried, so this can't loop.
        // Reuses the sweep batch size - same bounded-gas rationale.
        const target = state.lastSettledEpochId!; // UNSTAKE only fires when backlog exists
        fields = { functionName: 'unstakeBatch', args: [target, BigInt(cfg.sweepBatch)] };
        rec.unstaked = `${state.unstakeDone}->~${Math.min((state.unstakeDone ?? 0) + cfg.sweepBatch, state.unstakeTotal ?? 0)}/${state.unstakeTotal} (epoch ${target})`;
        break;
      }
    }

    if (fields) {
      // Send with bounded gas escalation. The helper AWAITs the receipt so only one action
      // lands per market per tick (no nonce races). CRITICAL: a tx can be MINED-but-REVERTED
      // (StartDelayExceeded / StartPriceTooOld / SettlePriceTooOld / paused / StalePrice) -
      // a revert is returned (NOT escalated) and inspected below; a non-'success' status is a
      // FAILURE, not success, else the keeper re-sends the same doomed crank every tick. A
      // receipt-wait TIMEOUT (tx stuck) is what the helper escalates; exhausting the attempts
      // rethrows, and the outer catch records it as a tick FAILURE (backoff/WEDGED path).
      try {
        const { txHash, receipt, gasSpentWei } = await sendWriteWithEscalation(
          client,
          wallet,
          base,
          fields,
          cfg,
          { market: market.id, action },
          // Record the broadcast hash immediately so a receipt-wait TIMEOUT (the helper throws
          // after exhausting escalation) still surfaces which tx may be pending via rec.txHash.
          (h) => {
            rec.txHash = h;
          },
          send,
        );
        rec.txHash = txHash;
        rec.gasSpentWei = gasSpentWei;
        if (receipt.status !== 'success') {
          rec.error = `tx reverted: ${action}`;
        } else if (action === 'SWEEP') {
          // Record which epochId was swept so the loop can persist this in the runtime.
          // This allows decideAction to distinguish Resolved-empty from Swept-empty on
          // subsequent ticks (both appear as cursor==0==stakedCount in the PhaseView).
          rec.sweptEpochId = state.currentEpochId;
        }
      } catch (writeErr) {
        // RESTART-FRAGILITY AUTO-RECOVERY (v1 + v2). After a keeper restart, the in-memory
        // lastSweptEpochId resets to null, so for an ALREADY-swept empty epoch decideAction
        // can't tell Swept-empty from Resolved-empty (both collapse to cursor==0==stakedCount)
        // and re-issues SWEEP. The contract then reverts SweepAlreadyDone() (0x562d6d1b). That
        // is NOT a real failure - the sweep genuinely IS done - so do NOT count it toward
        // WEDGED. Instead, RECORD the sweep (rec.sweptEpochId) so the loop persists
        // lastSweptEpochId and the VERY NEXT tick decides FINALIZE, and leave rec.error UNSET so
        // the breaker/backoff is not advanced. Converges: SWEEP -> SweepAlreadyDone -> (learn)
        // -> FINALIZE, with zero operator action. SweepAlreadyDone is unambiguous, so this is
        // always correct (no masking risk). Every OTHER error (incl. non-SWEEP actions) falls
        // through to the outer catch UNCHANGED.
        const sweepDone =
          isSweepAlreadyDone(writeErr) ||
          (writeErr instanceof WouldRevertError && writeErr.info.name === 'SweepAlreadyDone');
        if (action === 'SWEEP' && sweepDone) {
          rec.sweptEpochId = state.currentEpochId;
          logLine({
            msg: 'keeper.sweep.alreadyDone',
            market: market.id,
            epochId: state.currentEpochId,
            note: 'sweep already complete for this epoch (post-restart) - marking swept, will FINALIZE next tick',
          });
        } else {
          throw writeErr; // not the benign case - preserve the existing failure handling
        }
      }
    }
  } catch (err) {
    if (err instanceof SpendCapTrippedError) {
      // The persisted spend cap is OPEN - the keeper must STOP. The loop reads spendCapTripped
      // and halts all cranking; the trip is sticky on disk so a restart stays stopped.
      rec.error = err.message;
      rec.spendCapTripped = err.reason ?? 'cap';
    } else if (err instanceof WouldRevertError) {
      // Pre-flight simulation caught a doomed crank - NO tx was sent, so ZERO gas burned (this is
      // the drain the fix eliminates). Record the reason so the loop can apply the right backoff.
      rec.error = `would revert: ${err.info.name} (${rec.action}) - skipped before broadcast`;
      rec.revertReason = err.info.name;
      rec.simSkipped = true;
    } else if (err instanceof WaitForTransactionReceiptTimeoutError) {
      // A receipt-wait timeout is a distinct, expected failure mode: the tx WAS submitted
      // (nonce consumed) but didn't mine within receiptTimeoutMs. Annotate it loudly so the
      // operator knows the tx may still land out-of-band; the breaker still backs off.
      rec.error = `receipt wait timed out after ${cfg.receiptTimeoutMs}ms (tx ${rec.txHash ?? '?'} may still be pending): ${err.shortMessage}`;
    } else {
      rec.error = err instanceof Error ? err.message : String(err);
    }
  }

  logTick(rec);
  return rec;
}

/**
 * v2 ONLY - OPTIONAL per-epoch subsidy via the owner key's `fundSubsidy(epochId, amount)`.
 * This is what makes staking +EV (external value injected into the pot). It runs at most
 * once per epoch and is a STRICT no-op unless ALL of these hold:
 *   - the market is v2 (v1 has no fundSubsidy);
 *   - a subsidy amount is configured (market.subsidyPerEpoch > 0);
 *   - an owner key is configured (fundSubsidy is onlyOwner - the keeper key can't call it);
 *   - the epoch exists (currentEpochId != 0) and its phase is < Resolved (None/EntryOpen, or
 *     Running with settlePrice18 == 0 - once ended, fundSubsidy reverts WrongPhase).
 *
 * IDEMPOTENCE is on-chain, not in-memory: it reads the epoch's already-committed `subsidyUSDC`
 * and only tops up the REMAINING amount toward the configured target, hard-clamped to the
 * arena's `maxSubsidyPerEpoch`. So a restart never double-funds, and a partial prior fund is
 * completed. A USDC `approve` to the arena is issued first when allowance is short.
 *
 * Best-effort: it CATCHES its own errors and logs `keeper.subsidy.error` rather than failing
 * the lifecycle tick (a subsidy hiccup must never wedge the crank). Success sets
 * rec.fundedSubsidyEpochId. The owner key is used SOLELY for the approve + fundSubsidy here
 * and for emergencySettle - never for a normal lifecycle crank.
 */
async function maybeFundSubsidy(
  client: PublicClient,
  market: MarketConfig,
  cfg: KeeperConfig,
  state: KeeperState,
  owner: { wallet: WalletClient; account: Account } | undefined,
  rec: TickLog,
  chain: Chain,
): Promise<void> {
  // Gate 1: v2 + configured amount + owner key present.
  if (market.version !== 'v2') return;
  const target = market.subsidyPerEpoch;
  if (target === undefined || target <= 0n) return;
  if (owner === undefined) return;
  // Gate 2: an epoch exists and is still fundable (phase < Resolved).
  if (state.currentEpochId === 0n) return;
  if (state.paused) return; // fundSubsidy is whenNotPaused
  const fundable =
    state.phase === PhaseView.Idle ||
    state.phase === PhaseView.EntryOpen ||
    (state.phase === PhaseView.Running && state.settlePrice18 === 0n);
  if (!fundable) return;

  const abi = arenaAbiFor(market);
  try {
    // Read the arena's USDC token, this epoch's already-committed subsidy, and the cap.
    const [usdc, epoch, maxSubsidy] = await Promise.all([
      client.readContract({ address: market.arena, abi, functionName: 'USDC' }) as Promise<`0x${string}`>,
      client.readContract({ address: market.arena, abi, functionName: 'currentEpoch' }) as Promise<{ subsidyUSDC: bigint }>,
      client.readContract({ address: market.arena, abi, functionName: 'maxSubsidyPerEpoch' }) as Promise<bigint>,
    ]);

    // Clamp the per-epoch target to the contract's hard cap, then compute the remaining top-up.
    const cappedTarget = target > maxSubsidy ? maxSubsidy : target;
    const already = epoch.subsidyUSDC;
    if (already >= cappedTarget) return; // already funded to (or above) the target this epoch
    const topUp = cappedTarget - already;
    if (topUp <= 0n) return;

    // Ensure the owner has approved enough USDC to the arena (fundSubsidy pulls it). Approve
    // the exact top-up when allowance is short (idempotent - re-approves only when needed).
    const allowance = (await client.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner.account.address, market.arena],
    })) as bigint;
    if (allowance < topUp) {
      await sendWriteWithEscalation(
        client,
        owner.wallet,
        { address: usdc, abi: erc20Abi as unknown as Abi, account: owner.account, chain },
        { functionName: 'approve', args: [market.arena, topUp] },
        cfg,
        { market: market.id, action: 'SUBSIDY_APPROVE' },
      );
    }

    // Fund the remaining amount with the OWNER key (onlyOwner). A mined-revert is logged, not
    // re-thrown, so the lifecycle tick is unaffected.
    const { txHash, receipt } = await sendWriteWithEscalation(
      client,
      owner.wallet,
      { address: market.arena, abi, account: owner.account, chain },
      { functionName: 'fundSubsidy', args: [state.currentEpochId, topUp] },
      cfg,
      { market: market.id, action: 'SUBSIDY' },
    );
    if (receipt.status === 'success') {
      rec.fundedSubsidyEpochId = state.currentEpochId;
      logLine({ msg: 'keeper.subsidy.funded', market: market.id, epochId: state.currentEpochId, amount: topUp, totalTarget: cappedTarget, txHash });
    } else {
      logLine({ msg: 'keeper.subsidy.error', market: market.id, epochId: state.currentEpochId, error: 'fundSubsidy reverted', txHash });
    }
  } catch (err) {
    // Never let a subsidy problem wedge the lifecycle crank - log + move on.
    logLine({ msg: 'keeper.subsidy.error', market: market.id, epochId: state.currentEpochId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Fetch a fresh Hermes update and price its on-chain update fee via Pyth.getUpdateFee. */
export async function fetchUpdateAndFee(
  client: PublicClient,
  cfg: KeeperConfig,
  feedId: MarketConfig['feedId'],
  quoteFeedId?: MarketConfig['quoteFeedId'],
): Promise<{ priceData: `0x${string}`[]; fee: bigint }> {
  // CROSS market (e.g. cirBTC/EURC = BTC/EUR): post ONE blob covering BOTH feeds so the on-chain
  // CompositePythOracle reads both legs fresh. Single-feed markets are unchanged.
  const priceData = quoteFeedId
    ? await fetchPythUpdateMulti(cfg.hermesUrl, [feedId, quoteFeedId], cfg.hermesTimeoutMs)
    : await fetchPythUpdate(cfg.hermesUrl, feedId, cfg.hermesTimeoutMs);
  const fee = await client.readContract({
    address: cfg.pythAddress,
    abi: pythAbi,
    functionName: 'getUpdateFee',
    args: [priceData],
  });
  return { priceData, fee };
}
