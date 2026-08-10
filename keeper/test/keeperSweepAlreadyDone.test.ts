// keeperSweepAlreadyDone.test.ts — RESTART-FRAGILITY auto-recovery for the empty-epoch
// double-sweep wedge. An EMPTY epoch (stakedCount==0) still needs exactly ONE sweep()
// (internal Resolved->Swept) before finalize. The collapsed EpochView reports
// cursor==0==stakedCount for BOTH Resolved-empty and Swept-empty, so decideAction relies on
// the in-memory lastSweptEpochId to tell them apart. After a keeper RESTART (power loss),
// lastSweptEpochId resets to null -> for an already-swept empty epoch it WRONGLY re-issues
// SWEEP -> the contract reverts SweepAlreadyDone() (selector 0x562d6d1b). Pre-fix the keeper
// counted that as a failure -> consecutiveFailures climbs -> WEDGED. These tests prove the fix:
// a SweepAlreadyDone revert is treated as BENIGN + RECOVERABLE — the epoch is MARKED swept
// (so the next decideAction returns FINALIZE) and the failure counter is NOT advanced. Covers
// v1 AND v2, and proves OTHER sweep reverts still count as failures (unchanged).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  toFunctionSelector,
} from 'viem';
import { runMarketOnce, isSweepAlreadyDone, SWEEP_ALREADY_DONE_SELECTOR } from '../src/keeper.js';
import { decideAction, PhaseView, type KeeperState } from '../src/decide.js';
import { feeArenaAbi, feeArenaV2Abi } from '../src/abi.js';
import { recordFailure, recordSuccess, freshRuntime, type MarketRuntime } from '../src/backoff.js';
import type { KeeperConfig, MarketConfig } from '../src/config.js';

const V1_MARKET: MarketConfig = {
  id: 'eth',
  label: 'ETH / USDC',
  arena: '0xEcb0161E74ad9381e42f3f9d51Bb08324bD17D5c',
  feedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  version: 'v1',
};

const V2_MARKET: MarketConfig = {
  id: 'btc',
  label: 'BTC / USDC',
  arena: '0xEcb0161E74ad9381e42f3f9d51Bb08324bD17D5c',
  feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  version: 'v2',
};

const CFG: KeeperConfig = {
  rpcUrl: 'http://localhost:8545',
  rpcUrls: ['http://localhost:8545'],
  privateKey: `0x${'1'.repeat(64)}`,
  pythAddress: '0x2880aB155794e7179c9eE2e38200202908C17B43',
  hermesUrl: 'https://hermes.pyth.network',
  markets: [V1_MARKET],
  pollIntervalMs: 15000,
  sweepBatch: 50,
  txGasCap: 16_777_216n,
  tickDeadlineMs: 90000,
  stallExitMs: 300000,
  gasFloorWei: 20_000_000_000n,
  hermesTimeoutMs: 8000,
  receiptTimeoutMs: 90000,
  lowBalanceWei: 500_000_000_000_000_000n,
  gasEscalation: { floorWei: 20_000_000_000n, capWei: 100_000_000_000n, multiplierBps: 12_500, maxAttempts: 0 },
  baseBackoffMs: 5000,
  maxBackoffMs: 300000,
  wedgedAlertThreshold: 5,
  httpPort: 0,
  httpHost: '127.0.0.1',
  stallFactor: 3,
  metricsPersistIntervalMs: 30_000,
  alert: { dedupeWindowMs: 900_000, heartbeatIntervalMs: 300_000, timeoutMs: 5_000 },
  v2WindowMarginSec: 2n,
  v2PollIntervalMs: 4_000,
  v3SampleSec: 60,
  v3SampleIntervalMs: 2_000,
};

const account = { address: '0x000000000000000000000000000000000000dEaD' } as never;
const chain = { id: 1 } as never;

// ---------------------------------------------------------------------------
// The REAL SweepAlreadyDone revert shape. A viem write that hits a node returning the
// custom-error revert bytes throws a ContractFunctionExecutionError wrapping a
// ContractFunctionRevertedError whose data carries selector 0x562d6d1b. We build it from the
// REAL keeper ABI so viem decodes errorName='SweepAlreadyDone' exactly as in production.
// ---------------------------------------------------------------------------
function makeSweepAlreadyDoneError(version: 'v1' | 'v2' | 'v3'): BaseError {
  const abi = version === 'v2' ? feeArenaV2Abi : feeArenaAbi;
  const reverted = new ContractFunctionRevertedError({
    abi: abi as never,
    data: SWEEP_ALREADY_DONE_SELECTOR as `0x${string}`, // the real 4-byte selector, no args
    functionName: 'sweep',
  });
  return new ContractFunctionExecutionError(reverted, {
    abi: abi as never,
    functionName: 'sweep',
    args: [50n],
  });
}

// A DIFFERENT, unrelated custom-error revert (SweepFailed-style) to prove non-SweepAlreadyDone
// reverts still count as failures. We use a generic Error here (the keeper's outer catch path).
function makeOtherSweepError(): Error {
  return new Error('execution reverted: SweepFailed() (some other custom error 0xdeadbeef)');
}

// ---------------------------------------------------------------------------
// The REAL LIVE shapes, reconstructed EXACTLY from a repro against the wedged v1 arena
// (epoch 80, sweep(50) reverts SweepAlreadyDone RIGHT NOW). Captured 2026-06-09 against
// https://rpc.testnet.arc.network, viem 2.19.4. Two distinct live shapes the keeper hit:
//
//  SHAPE A — raw eth_call (this is the EXACT one the keeper LOGGED): viem produces a
//   CallExecutionError -> ExecutionRevertedError -> RpcRequestError -> {data:'0x562d6d1b'}.
//   The selector survives uncorrupted ONLY at the innermost RPC object's `.data`. The
//   `.message`/`.details` Latin-1-render the 4 selector bytes as 'V-m\x1b' and DO NOT contain
//   the literal hex '0x562d6d1b' (only the calldata hex 0xaa60e733... appears). Both prior
//   detection paths (errorName + msg.includes('0x562d6d1b')) MISS this — the bug we fixed.
//
//  SHAPE B — simulate/estimate with an ABI that does NOT declare the error: viem produces a
//   ContractFunctionRevertedError whose `.signature === '0x562d6d1b'` (no decoded errorName),
//   and the message DOES contain the literal hex.
// ---------------------------------------------------------------------------

// The control-char string the raw bytes 0x56,0x2d,0x6d,0x1b Latin-1-decode to ('V-m\x1b').
const RAW_SELECTOR_AS_LATIN1 = String.fromCharCode(0x56, 0x2d, 0x6d, 0x1b);

// SHAPE A — reconstruct the nested error chain the live raw eth_call produced. We don't depend on
// viem's CallExecutionError ctor; a faithful plain-object cause chain reproduces what the repro
// dumped: message has 'V-m\x1b' + calldata (NOT the hex selector); innermost cause.data = selector.
function makeLiveRawCallError(): Error {
  const calldata = '0xaa60e7330000000000000000000000000000000000000000000000000000000000000032';
  // innermost: the raw RPC error object viem nests as RpcRequestError.cause
  const rpcRaw = { code: 3, message: 'execution reverted: ' + RAW_SELECTOR_AS_LATIN1, data: '0x562d6d1b' };
  const rpcRequestError = Object.assign(
    new Error(
      `RPC Request failed.\n\nURL: https://rpc.testnet.arc.network\nRequest body: {"method":"eth_call","params":[{"data":"${calldata}",...}]}\n\nDetails: execution reverted: ${RAW_SELECTOR_AS_LATIN1}\nVersion: 2.19.4`,
    ),
    { name: 'RpcRequestError', cause: rpcRaw },
  );
  const execReverted = Object.assign(
    new Error(
      `Execution reverted with reason: ${RAW_SELECTOR_AS_LATIN1}.\n\nDetails: execution reverted: ${RAW_SELECTOR_AS_LATIN1}\nVersion: 2.19.4`,
    ),
    { name: 'ExecutionRevertedError', details: 'execution reverted: ' + RAW_SELECTOR_AS_LATIN1, cause: rpcRequestError },
  );
  const callExecError = Object.assign(
    new Error(
      `Execution reverted with reason: ${RAW_SELECTOR_AS_LATIN1}.\n\nRaw Call Arguments:\n  from:  0xB964fC0BB9d4226935Bb316E602c7E93455F359B\n  to:    0xD0aEDc19E1C27E7643255432006942ccFba5B8CE\n  data:  ${calldata}\n\nDetails: execution reverted: ${RAW_SELECTOR_AS_LATIN1}\nVersion: 2.19.4`,
    ),
    { name: 'CallExecutionError', details: 'execution reverted: ' + RAW_SELECTOR_AS_LATIN1, cause: execReverted },
  );
  return callExecError;
}

// SHAPE B — undecoded-ABI ContractFunctionRevertedError: errorName UNSET, .signature = selector,
// message DOES carry the literal hex. We build the real viem typed error WITHOUT the error in the
// ABI so .data.errorName never resolves (forcing reliance on .signature / hex).
function makeUndecodedSignatureError(): BaseError {
  const abiNoError = (feeArenaAbi as readonly unknown[]).filter(
    (x) => !(typeof x === 'object' && x !== null && (x as { type?: string }).type === 'error' && (x as { name?: string }).name === 'SweepAlreadyDone'),
  );
  const reverted = new ContractFunctionRevertedError({
    abi: abiNoError as never,
    data: SWEEP_ALREADY_DONE_SELECTOR as `0x${string}`,
    functionName: 'sweep',
  });
  return new ContractFunctionExecutionError(reverted, {
    abi: abiNoError as never,
    functionName: 'sweep',
    args: [50n],
  });
}

// An EMPTY (stakedCount==0) ENDED epoch view: settlePrice18 set, cursor==0==stakedCount. For
// v2 we collapse the RAW Swept(4) phase to Running in readState, but here we feed the same
// collapsed-space fixture both versions consume (phase=Running + settlePrice18 != 0 = ended).
function emptyEndedEpoch(over: Partial<Record<string, unknown>> = {}) {
  return {
    epochId: 80n,
    phase: PhaseView.Running,
    entryOpenTime: 0n,
    entryCloseTime: 1000n,
    startTime: 1100n,
    endTime: 2000n,
    startTimeActual: 0n,
    settleTimeActual: 0n,
    bandBps: 100,
    startPrice18: 3000n,
    settlePrice18: 9999n, // ENDED/resolved
    deltaBps: 0n,
    winningSide: 0,
    rolledOver: false,
    rolloverConsumed: false,
    stakedCount: 0, // EMPTY epoch
    sweepCursor: 0,
    potWETH: 0n,
    potUSDC: 0n,
    sideContribution6: [0n, 0n, 0n, 0n],
    winnerDenominator: 0n,
    rolloverPendingIn: false,
    rolloverInWETH: 0n,
    rolloverInUSDC: 0n,
    // v2-only fields (ignored by v1 decode; harmless extras)
    claimedWETH: 0n,
    claimedUSDC: 0n,
    claimedCount: 0,
    subsidyUSDC: 0n,
    sideConviction: [0n, 0n, 0n, 0n],
    winnerSqrtConvSum: 0n,
    winningConvictionSum: 0n,
    refundedConviction: 0n,
    convRefundedCount: 0,
    burnedConviction: 0n,
    ...over,
  };
}

type WriteArg = Record<string, unknown>;

// Build clients whose writeContract THROWS the supplied error (the realistic SweepAlreadyDone
// path: viem surfaces the decoded revert during the write, before any receipt). Other reads
// behave normally so readState yields the empty-ended epoch.
function makeThrowingClients(opts: {
  epochId: bigint;
  epoch: ReturnType<typeof emptyEndedEpoch>;
  throwOnWrite: unknown;
  settleWindow?: number;
}) {
  const writeContract = vi.fn(async (_req: WriteArg): Promise<`0x${string}`> => {
    throw opts.throwOnWrite;
  });
  const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' as const }));
  const readContract = vi.fn(async (req: { functionName: string }) => {
    switch (req.functionName) {
      case 'currentEpochId':
        return opts.epochId;
      case 'currentEpoch':
        return opts.epoch;
      case 'maxStartDelay':
        return 600;
      case 'paused':
        return false;
      case 'settleWindow':
        return opts.settleWindow ?? 12;
      default:
        throw new Error(`unexpected read ${req.functionName}`);
    }
  });
  const publicClient = { readContract, waitForTransactionReceipt } as never;
  const walletClient = { writeContract } as never;
  return { publicClient, walletClient, writeContract };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ===========================================================================
// The detection helper itself — exact selector + decoded errorName.
// ===========================================================================
describe('isSweepAlreadyDone — robust detection of the SweepAlreadyDone revert', () => {
  it('the selector constant is the real keccak256("SweepAlreadyDone()")[:4] = 0x562d6d1b', () => {
    expect(SWEEP_ALREADY_DONE_SELECTOR).toBe('0x562d6d1b');
    expect(toFunctionSelector('SweepAlreadyDone()')).toBe(SWEEP_ALREADY_DONE_SELECTOR);
  });

  it('detects a decoded ContractFunctionRevertedError (errorName=SweepAlreadyDone) — v1 ABI', () => {
    expect(isSweepAlreadyDone(makeSweepAlreadyDoneError('v1'))).toBe(true);
  });

  it('detects a decoded ContractFunctionRevertedError (errorName=SweepAlreadyDone) — v2 ABI', () => {
    expect(isSweepAlreadyDone(makeSweepAlreadyDoneError('v2'))).toBe(true);
  });

  it('detects a plain-Error revert whose message carries the raw selector 0x562d6d1b', () => {
    expect(isSweepAlreadyDone(new Error('execution reverted, data: 0x562d6d1b'))).toBe(true);
  });

  // ---- THE LIVE BUG: the EXACT shape the keeper logged in production (raw eth_call). ----
  // Pre-fix this returned FALSE: errorName never resolved (CallExecutionError, not a decoded
  // ContractFunctionRevertedError) AND the message has 'V-m\x1b' but NOT the hex '0x562d6d1b'.
  it('detects SHAPE A — the LIVE raw-eth_call error (selector at innermost cause.data, message has V-m\\x1b not hex)', () => {
    const live = makeLiveRawCallError();
    // sanity: this faithfully reproduces the live shape — message has the control-char bytes,
    // NOT the literal hex; the selector survives only as structured .data deep in the chain.
    expect(live.message).toContain(RAW_SELECTOR_AS_LATIN1);
    expect(live.message.toLowerCase()).not.toContain('0x562d6d1b');
    expect(isSweepAlreadyDone(live)).toBe(true);
  });

  // The selector lives in structured revert data (innermost RPC object .data) — detected even if
  // the message rendering were stripped entirely (signal (b), the primary robust path).
  it('detects via structured revert .data === 0x562d6d1b deep in the cause chain', () => {
    const err = Object.assign(new Error('Execution reverted with reason: V-m.'), {
      cause: { code: 3, message: 'reverted', data: '0x562d6d1b' },
    });
    expect(isSweepAlreadyDone(err)).toBe(true);
  });

  // SHAPE B — undecoded-ABI: errorName unset, .signature = selector, message has the literal hex.
  it('detects SHAPE B — undecoded ContractFunctionRevertedError (.signature = selector, hex in message)', () => {
    const err = makeUndecodedSignatureError();
    expect(err.message.toLowerCase()).toContain('0x562d6d1b'); // sanity: hex present here
    expect(isSweepAlreadyDone(err)).toBe(true);
  });

  // Message-only fallback (signal c): even with no structured data at all, the distinctive
  // 'V-m\x1b' control sequence in the message is enough.
  it('detects via the message-only V-m\\x1b fallback (no structured data anywhere)', () => {
    expect(isSweepAlreadyDone(new Error(`Execution reverted with reason: ${RAW_SELECTOR_AS_LATIN1}.`))).toBe(true);
  });

  it('does NOT match an unrelated revert (no false positive)', () => {
    expect(isSweepAlreadyDone(makeOtherSweepError())).toBe(false);
    expect(isSweepAlreadyDone(new Error('connection reset'))).toBe(false);
    expect(isSweepAlreadyDone(undefined)).toBe(false);
  });

  // The fallbacks are SCOPED to this one selector — a DIFFERENT selector (0xdeadbeef) in the same
  // live-shaped structured-data OR message position must NOT match (proves we never broad-match).
  it('does NOT match a different selector (0xdeadbeef) in structured .data nor in the message', () => {
    // structured .data with a different selector
    const dataErr = Object.assign(new Error('Execution reverted with reason: foo.'), {
      cause: { code: 3, message: 'reverted', data: '0xdeadbeef' },
    });
    expect(isSweepAlreadyDone(dataErr)).toBe(false);
    // .signature with a different selector
    const sigErr = Object.assign(new Error('reverted with signature 0xdeadbeef'), {
      cause: { signature: '0xdeadbeef' },
    });
    expect(isSweepAlreadyDone(sigErr)).toBe(false);
    // a normal string reason that happens to contain the bytes V, -, m but NOT the 0x1b ESC tail
    // (e.g. a human revert string) must NOT trip the control-char fallback.
    expect(isSweepAlreadyDone(new Error('Execution reverted with reason: V-meal not found'))).toBe(false);
    expect(isSweepAlreadyDone(new Error('Execution reverted with reason: V-m'))).toBe(false);
  });
});

// ===========================================================================
// (a) SWEEP reverts SweepAlreadyDone -> epoch MARKED swept + next decideAction = FINALIZE.
// (b) consecutiveFailures / backoff NOT advanced toward WEDGED.
// (c) OTHER sweep reverts STILL count as failures (unchanged).
// (d) works for BOTH a v1 market and a v2 market.
// ===========================================================================
for (const market of [V1_MARKET, V2_MARKET]) {
  describe(`runMarketOnce — SweepAlreadyDone auto-recovery (${market.version})`, () => {
    // (a) The post-restart wedge: lastSweptEpochId=null, empty ended epoch -> decideAction
    // returns SWEEP, the write reverts SweepAlreadyDone, and the keeper recovers benignly.
    it('(a) SWEEP write reverts SweepAlreadyDone -> marks epoch swept (rec.sweptEpochId set), NO rec.error', async () => {
      const { publicClient, walletClient, writeContract } = makeThrowingClients({
        epochId: 80n,
        epoch: emptyEndedEpoch({ epochId: 80n }),
        throwOnWrite: makeSweepAlreadyDoneError(market.version),
      });

      // lastSweptEpochId = null simulates the FRESH post-restart runtime.
      const rec = await runMarketOnce(publicClient, walletClient, account, chain, market, CFG, null);

      expect(rec.action).toBe('SWEEP'); // it DID decide to sweep (can't tell swept-empty apart)
      expect(writeContract).toHaveBeenCalledOnce(); // it DID attempt the sweep
      expect(rec.error).toBeUndefined(); // ...but SweepAlreadyDone is BENIGN, not a failure
      expect(rec.sweptEpochId).toBe(80n); // and the epoch is recorded as swept
    });

    // (a continued) The VERY NEXT decideAction, with lastSweptEpochId now learned, returns
    // FINALIZE (not SWEEP) — proving convergence SWEEP -> SweepAlreadyDone -> (learn) -> FINALIZE.
    it('(a) after recovery, the next decideAction returns FINALIZE (not SWEEP)', async () => {
      const ended = emptyEndedEpoch({ epochId: 80n });
      const stateAfterLearn: KeeperState = {
        currentEpochId: 80n,
        phase: PhaseView.Running,
        entryCloseTime: ended.entryCloseTime,
        startTime: ended.startTime,
        endTime: ended.endTime,
        settlePrice18: ended.settlePrice18,
        sweepCursor: ended.sweepCursor,
        stakedCount: ended.stakedCount,
        nowSec: 10_000n,
        maxStartDelay: 600n,
        paused: false,
        lastSweptEpochId: 80n, // the loop just persisted rec.sweptEpochId
      };
      expect(decideAction(stateAfterLearn)).toBe('FINALIZE');

      // And with the FRESH (null) runtime BEFORE recovery, it would (wrongly, but unavoidably)
      // choose SWEEP — which is exactly what triggers the benign revert above.
      expect(decideAction({ ...stateAfterLearn, lastSweptEpochId: null })).toBe('SWEEP');
    });

    // (a end-to-end) Re-run the tick with the learned lastSweptEpochId -> the keeper FINALIZEs,
    // never sweeps again. Uses a non-throwing client for this confirming tick.
    it('(a) feeding the recovered lastSweptEpochId back -> the tick FINALIZEs (no re-sweep)', async () => {
      const writeContract = vi.fn(async (_r: WriteArg) => '0xfin' as `0x${string}`);
      const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' as const }));
      const readContract = vi.fn(async (req: { functionName: string }) => {
        switch (req.functionName) {
          case 'currentEpochId':
            return 80n;
          case 'currentEpoch':
            return emptyEndedEpoch({ epochId: 80n });
          case 'maxStartDelay':
            return 600;
          case 'paused':
            return false;
          case 'settleWindow':
            return 12;
          default:
            throw new Error(`unexpected read ${req.functionName}`);
        }
      });
      const publicClient = { readContract, waitForTransactionReceipt } as never;
      const walletClient = { writeContract } as never;

      const rec = await runMarketOnce(publicClient, walletClient, account, chain, market, CFG, 80n);
      expect(rec.action).toBe('FINALIZE');
      expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('finalizeSettle');
      expect(rec.error).toBeUndefined();
    });

    // (b) The benign recovery must NOT advance the circuit-breaker. Mirror the loop's branch
    // logic (index.ts): rec.error undefined -> recordSuccess (resets failures), and
    // lastSweptEpochId is updated from rec.sweptEpochId.
    it('(b) consecutiveFailures / backoff is NOT advanced toward WEDGED on SweepAlreadyDone', async () => {
      const { publicClient, walletClient } = makeThrowingClients({
        epochId: 80n,
        epoch: emptyEndedEpoch({ epochId: 80n }),
        throwOnWrite: makeSweepAlreadyDoneError(market.version),
      });

      // Start from a runtime that already had some failures (e.g. flaky RPC before the sweep).
      const before: MarketRuntime = { ...freshRuntime(), consecutiveFailures: 3, backoffUntilMs: 0 };
      const rec = await runMarketOnce(publicClient, walletClient, account, chain, market, CFG, before.lastSweptEpochId);

      // rec.error undefined => the loop takes the SUCCESS branch: failures reset + sweep learned.
      expect(rec.error).toBeUndefined();
      const after = recordSuccess(before);
      const persisted: MarketRuntime = {
        ...after,
        lastSweptEpochId: rec.sweptEpochId !== undefined ? rec.sweptEpochId : after.lastSweptEpochId,
      };
      expect(persisted.consecutiveFailures).toBe(0); // NOT climbing toward WEDGED
      expect(persisted.backoffUntilMs).toBe(0); // no backoff armed
      expect(persisted.lastSweptEpochId).toBe(80n); // the sweep IS learned
      expect(persisted.consecutiveFailures).toBeLessThan(CFG.wedgedAlertThreshold);
    });

    // (c) A DIFFERENT sweep revert is STILL a failure (unchanged) — the breaker advances and a
    // streak would eventually WEDGE. Proves the recovery is narrow to SweepAlreadyDone only.
    it('(c) a NON-SweepAlreadyDone sweep revert still counts as a FAILURE (unchanged)', async () => {
      const { publicClient, walletClient, writeContract } = makeThrowingClients({
        epochId: 80n,
        epoch: emptyEndedEpoch({ epochId: 80n }),
        throwOnWrite: makeOtherSweepError(),
      });

      const rec = await runMarketOnce(publicClient, walletClient, account, chain, market, CFG, null);

      expect(rec.action).toBe('SWEEP');
      expect(writeContract).toHaveBeenCalledOnce();
      expect(rec.error).toMatch(/SweepFailed/); // captured as an error -> tick FAILURE
      expect(rec.sweptEpochId).toBeUndefined(); // NOT marked swept (the sweep did not happen)

      // The loop's FAILURE branch advances the breaker toward WEDGED (unchanged behavior).
      const before: MarketRuntime = { ...freshRuntime(), consecutiveFailures: 4 };
      const after = recordFailure(before, Date.now(), CFG.baseBackoffMs, CFG.maxBackoffMs);
      expect(after.consecutiveFailures).toBe(5);
      expect(after.consecutiveFailures).toBeGreaterThanOrEqual(CFG.wedgedAlertThreshold); // WOULD wedge
    });

    // (c continued) A non-empty SWEEP that reverts SweepAlreadyDone is ALSO recovered benignly
    // (e.g. a restart mid-drain after the final batch already flipped Swept). The recovery keys
    // off the action+error, not stakedCount, so it applies uniformly.
    it('(c) a SweepAlreadyDone revert on a NON-empty epoch is also recovered benignly', async () => {
      const { publicClient, walletClient } = makeThrowingClients({
        epochId: 80n,
        epoch: emptyEndedEpoch({ epochId: 80n, sweepCursor: 0, stakedCount: 200 }), // cursor<total -> SWEEP
        throwOnWrite: makeSweepAlreadyDoneError(market.version),
      });
      const rec = await runMarketOnce(publicClient, walletClient, account, chain, market, CFG, null);
      expect(rec.action).toBe('SWEEP');
      expect(rec.error).toBeUndefined();
      expect(rec.sweptEpochId).toBe(80n); // mark swept -> FINALIZE next
    });
  });
}

// ===========================================================================
// SAFETY: the recovery is SCOPED to the SWEEP action. A SweepAlreadyDone-shaped error thrown
// during a NON-sweep write must NOT be swallowed (it would be a genuine, unexpected failure).
// ===========================================================================
describe('runMarketOnce — SweepAlreadyDone recovery is scoped to SWEEP only', () => {
  it('a SweepAlreadyDone-shaped error on a non-SWEEP action is NOT swallowed (still a failure)', async () => {
    // Force an OPEN action (Idle) whose write throws a SweepAlreadyDone-shaped error. Because the
    // action is not SWEEP, the keeper must rethrow it to the outer catch -> rec.error set.
    const writeContract = vi.fn(async (_r: WriteArg): Promise<`0x${string}`> => {
      throw makeSweepAlreadyDoneError('v1');
    });
    const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' as const }));
    const readContract = vi.fn(async (req: { functionName: string }) => {
      switch (req.functionName) {
        case 'currentEpochId':
          return 1n;
        case 'currentEpoch':
          return emptyEndedEpoch({ epochId: 1n, phase: PhaseView.Idle, settlePrice18: 0n });
        case 'maxStartDelay':
          return 600;
        case 'paused':
          return false;
        default:
          throw new Error(`unexpected read ${req.functionName}`);
      }
    });
    const publicClient = { readContract, waitForTransactionReceipt } as never;
    const walletClient = { writeContract } as never;

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V1_MARKET, CFG, null);
    expect(rec.action).toBe('OPEN');
    expect(rec.error).toBeDefined(); // NOT swallowed — a non-sweep failure is preserved
    expect(rec.sweptEpochId).toBeUndefined();
  });
});
