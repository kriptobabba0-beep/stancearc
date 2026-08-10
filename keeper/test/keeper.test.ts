import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WaitForTransactionReceiptTimeoutError } from 'viem';
import { runMarketOnce } from '../src/keeper.js';
import { PhaseView } from '../src/decide.js';
import type { KeeperConfig, MarketConfig } from '../src/config.js';

// Minimal stand-ins for the viem clients. We assert which write the keeper chose for a
// given on-chain state, plus that the gas floor + (for START/END) the Pyth fee/value
// are wired through. We never hit a real chain.

const MARKET: MarketConfig = {
  id: 'eth',
  label: 'ETH / USDC',
  arena: '0xEcb0161E74ad9381e42f3f9d51Bb08324bD17D5c',
  feedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  version: 'v1',
};

const CFG: KeeperConfig = {
  rpcUrl: 'http://localhost:8545',
  rpcUrls: ['http://localhost:8545'],
  privateKey: `0x${'1'.repeat(64)}`,
  pythAddress: '0x2880aB155794e7179c9eE2e38200202908C17B43',
  hermesUrl: 'https://hermes.pyth.network',
  markets: [MARKET],
  pollIntervalMs: 15000,
  sweepBatch: 50,
  txGasCap: 16_777_216n,
  tickDeadlineMs: 90000,
  stallExitMs: 300000,
  gasFloorWei: 20_000_000_000n,
  hermesTimeoutMs: 8000,
  receiptTimeoutMs: 90000,
  lowBalanceWei: 500_000_000_000_000_000n,
  // Gas escalation OFF (maxAttempts 0) so these tests assert the unchanged single floor-priced
  // send. The escalation logic is unit-tested in gasEscalation.test.ts + keeperEscalation.test.ts.
  gasEscalation: { floorWei: 20_000_000_000n, capWei: 100_000_000_000n, multiplierBps: 12_500, maxAttempts: 0 },
  baseBackoffMs: 5000,
  maxBackoffMs: 300000,
  wedgedAlertThreshold: 5,
  httpPort: 0,
  httpHost: '127.0.0.1',
  stallFactor: 3,
  metricsPersistIntervalMs: 30_000,
  // Alerting OFF (no URLs) — runMarketOnce doesn't touch the alerter; this only satisfies
  // the KeeperConfig shape now that it carries an `alert` block.
  alert: { dedupeWindowMs: 900_000, heartbeatIntervalMs: 300_000, timeoutMs: 5_000 },
  v2WindowMarginSec: 2n,
  v2PollIntervalMs: 4_000,
  v3SampleSec: 60,
  v3SampleIntervalMs: 2_000,
};

const account = { address: '0x000000000000000000000000000000000000dEaD' } as never;
const chain = { id: 1 } as never;

// A distinct owner account/wallet for the optional wedge auto-recovery path. The owner
// wallet's writeContract is a SEPARATE spy so tests can assert the keeper key is NEVER
// used for emergencySettle (and vice-versa).
const ownerAccount = { address: '0x0000000000000000000000000000000000000B0b' } as never;
function makeOwner() {
  const ownerWrite = vi.fn(async (_req: WriteArg) => '0xrecover' as `0x${string}`);
  const owner = { account: ownerAccount, wallet: { writeContract: ownerWrite } as never };
  return { owner, ownerWrite };
}

// A full EpochView tuple with overridable fields; defaults to a Running-not-ended epoch.
function epochView(over: Partial<Record<string, unknown>> = {}) {
  return {
    epochId: 1n,
    phase: PhaseView.Running,
    entryOpenTime: 0n,
    entryCloseTime: 1000n,
    startTime: 1100n,
    endTime: 2000n,
    startTimeActual: 0n,
    settleTimeActual: 0n,
    bandBps: 100,
    startPrice18: 3000n,
    settlePrice18: 0n,
    deltaBps: 0n,
    winningSide: 0,
    rolledOver: false,
    stakedCount: 0,
    sweepCursor: 0,
    potWETH: 0n,
    potUSDC: 0n,
    sideContribution6: [0n, 0n, 0n, 0n],
    winnerDenominator: 0n,
    rolloverPendingIn: false,
    rolloverInWETH: 0n,
    rolloverInUSDC: 0n,
    ...over,
  };
}

type WriteArg = Record<string, unknown>;

function makeClients(opts: {
  epochId: bigint;
  epoch: ReturnType<typeof epochView>;
  updateFee?: bigint;
  maxStartDelay?: number;
  paused?: boolean;
  receiptStatus?: 'success' | 'reverted';
  /** v1 auto-return reads — absent keys make the mock THROW (matching an old arena). */
  lastSettledEpochId?: bigint;
  unstakeProgress?: readonly [number, number];
}) {
  const writeContract = vi.fn(async (_req: WriteArg) => '0xabc' as `0x${string}`);
  const waitForTransactionReceipt = vi.fn(
    async (_req: { hash: `0x${string}`; timeout?: number }) => ({
      status: opts.receiptStatus ?? 'success',
    }),
  );

  const readContract = vi.fn(async (req: { functionName: string }) => {
    switch (req.functionName) {
      case 'currentEpochId':
        return opts.epochId;
      case 'currentEpoch':
        return opts.epoch;
      case 'maxStartDelay':
        return opts.maxStartDelay ?? 600;
      case 'paused':
        return opts.paused ?? false;
      case 'getUpdateFee':
        return opts.updateFee ?? 7n;
      case 'lastSettledEpochId':
        if (opts.lastSettledEpochId === undefined) throw new Error('unexpected read lastSettledEpochId');
        return opts.lastSettledEpochId;
      // The keeper reads the auto-return pair as unstakeCursor(id) + sweepProgress(id).
      case 'unstakeCursor':
        if (opts.unstakeProgress === undefined) throw new Error('unexpected read unstakeCursor');
        return opts.unstakeProgress[0];
      case 'sweepProgress':
        if (opts.unstakeProgress === undefined) throw new Error('unexpected read sweepProgress');
        return [opts.unstakeProgress[0], opts.unstakeProgress[1]];
      default:
        throw new Error(`unexpected read ${req.functionName}`);
    }
  });

  const publicClient = { readContract, waitForTransactionReceipt } as never;
  const walletClient = { writeContract } as never;
  return { publicClient, walletClient, writeContract, waitForTransactionReceipt };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('runMarketOnce — chooses & executes the right crank', () => {
  it('epochId 0 -> createEpoch with the gas floor', async () => {
    const { publicClient, walletClient, writeContract, waitForTransactionReceipt } = makeClients({
      epochId: 0n,
      epoch: epochView({ epochId: 0n, phase: PhaseView.Idle }),
    });

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);

    expect(rec.action).toBe('CREATE');
    expect(rec.error).toBeUndefined();
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('createEpoch');
    expect(call.maxFeePerGas).toBe(20_000_000_000n);
    expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
  });

  it('Idle -> openEntry', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Idle }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('OPEN');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('openEntry');
  });

  it('EntryOpen before entryClose -> NONE (no write)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.EntryOpen, entryCloseTime: 9_999_999_999n }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('NONE');
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('EntryOpen past entryClose -> startEpoch with Pyth update + fee as value', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ binary: { data: ['504e4155aa'] } }) })),
    );
    // entryClose is in the past but maxStartDelay is huge, so the real wall-clock is
    // still INSIDE the start window -> START (not the missed-window STUCK case).
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.EntryOpen, entryCloseTime: 1n }),
      maxStartDelay: 0xffffffff, // ~136 years; window effectively always open
      updateFee: 42n,
    });

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);

    expect(rec.action).toBe('START');
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('startEpoch');
    expect(call.value).toBe(42n);
    expect(call.args).toEqual([['0x504e4155aa']]);
    expect(call.maxFeePerGas).toBe(20_000_000_000n);
  });

  it('Running past endTime, not ended -> endEpoch with fresh update + fee', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ binary: { data: ['bb'] } }) })),
    );
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 0n, endTime: 1n }),
      updateFee: 9n,
    });

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);

    expect(rec.action).toBe('END');
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('endEpoch');
    expect(call.value).toBe(9n);
    expect(call.args).toEqual([['0xbb']]);
  });

  it('Resolved with cursor<total -> sweep(SWEEP_BATCH)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 200 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('SWEEP');
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('sweep');
    expect(call.args).toEqual([50n]);
  });

  it('Resolved with cursor==total -> finalizeSettle', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 200, stakedCount: 200 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('FINALIZE');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('finalizeSettle');
  });

  it('Settled with auto-return backlog -> unstakeBatch(lastSettledEpochId, SWEEP_BATCH)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      epoch: epochView({ epochId: 7n, phase: PhaseView.Settled }),
      lastSettledEpochId: 7n,
      unstakeProgress: [2, 5], // 2 of 5 returned -> backlog
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('UNSTAKE');
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('unstakeBatch');
    expect(call.args).toEqual([7n, 50n]);
    expect(rec.unstaked).toContain('2->');
    expect(rec.error).toBeUndefined();
  });

  it('Settled with auto-return fully drained -> createEpoch (no UNSTAKE loop)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      epoch: epochView({ epochId: 7n, phase: PhaseView.Settled }),
      lastSettledEpochId: 7n,
      unstakeProgress: [5, 5],
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('CREATE');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('createEpoch');
  });

  it('Settled on an OLD arena (auto-return reads revert) -> createEpoch, tick unharmed', async () => {
    // No lastSettledEpochId/unstakeProgress in opts -> the mock THROWS on those reads,
    // mirroring a pre-auto-return arena. The reads are best-effort: lifecycle unchanged.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      epoch: epochView({ epochId: 7n, phase: PhaseView.Settled }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('CREATE');
    expect(rec.error).toBeUndefined();
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('createEpoch');
  });

  it('captures errors instead of throwing out of the tick', async () => {
    const publicClient = {
      readContract: vi.fn(async () => {
        throw new Error('rpc down');
      }),
      waitForTransactionReceipt: vi.fn(),
    } as never;
    const walletClient = { writeContract: vi.fn() } as never;

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.error).toMatch(/rpc down/);
    expect(rec.action).toBe('NONE');
  });

  it('mined-but-REVERTED receipt -> tick is a FAILURE with rec.error set (not success)', async () => {
    // A SWEEP whose tx mines but reverts (status:'reverted'). Without inspecting the
    // receipt status this would be (wrongly) treated as success and re-sent every tick.
    const { publicClient, walletClient, writeContract, waitForTransactionReceipt } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 200 }),
      receiptStatus: 'reverted',
    });

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);

    expect(rec.action).toBe('SWEEP');
    expect(writeContract).toHaveBeenCalledOnce(); // it DID send
    expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
    expect(rec.txHash).toBe('0xabc');
    expect(rec.error).toBe('tx reverted: SWEEP'); // ...but the tick is a failure
  });

  it('a SUCCESS receipt leaves rec.error undefined', async () => {
    const { publicClient, walletClient } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 200 }),
      receiptStatus: 'success',
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('SWEEP');
    expect(rec.error).toBeUndefined();
  });

  it('successful SWEEP surfaces sweptEpochId so the loop can record it', async () => {
    const { publicClient, walletClient } = makeClients({
      epochId: 3n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 200 }),
      receiptStatus: 'success',
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('SWEEP');
    expect(rec.error).toBeUndefined();
    expect(rec.sweptEpochId).toBe(3n);
  });

  it('reverted SWEEP does NOT surface sweptEpochId', async () => {
    const { publicClient, walletClient } = makeClients({
      epochId: 3n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 200 }),
      receiptStatus: 'reverted',
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('SWEEP');
    expect(rec.error).toBeDefined();
    expect(rec.sweptEpochId).toBeUndefined();
  });

  it('passes cfg.receiptTimeoutMs as the timeout to waitForTransactionReceipt', async () => {
    const { publicClient, walletClient, waitForTransactionReceipt } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Idle }), // -> OPEN (a write that awaits a receipt)
    });

    await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);

    expect(waitForTransactionReceipt).toHaveBeenCalledOnce();
    const arg = waitForTransactionReceipt.mock.calls[0]![0];
    expect(arg.timeout).toBe(CFG.receiptTimeoutMs); // 90000
  });

  it('receipt-wait TIMEOUT -> tick is a FAILURE (rec.error set), not a hang, not a success', async () => {
    // A stuck/dropped tx: viem throws WaitForTransactionReceiptTimeoutError instead of
    // polling forever. The tick must resolve as a failure so the backoff/WEDGED breaker
    // handles it — it must NOT hang and must NOT be treated as success.
    const { publicClient, walletClient, writeContract, waitForTransactionReceipt } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Idle }), // -> OPEN
    });
    waitForTransactionReceipt.mockRejectedValueOnce(
      new WaitForTransactionReceiptTimeoutError({ hash: '0xabc' }),
    );

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);

    expect(rec.action).toBe('OPEN');
    expect(writeContract).toHaveBeenCalledOnce(); // the tx WAS sent (nonce consumed)
    expect(rec.txHash).toBe('0xabc');
    expect(rec.error).toBeDefined(); // ...but the tick is a failure
    expect(rec.error).toMatch(/receipt wait timed out/i);
    expect(rec.sweptEpochId).toBeUndefined();
  });

  it('a generic (non-timeout) receipt-wait rejection is still captured as a failure', async () => {
    const { publicClient, walletClient, waitForTransactionReceipt } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Idle }), // -> OPEN
    });
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('connection reset'));

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);

    expect(rec.action).toBe('OPEN');
    expect(rec.error).toMatch(/connection reset/);
  });

  it('empty epoch (stakedCount==0) with lastSweptEpochId=null -> SWEEP (mandatory one-time sweep)', async () => {
    // stakedCount==0 and no prior sweep recorded: decideAction should return SWEEP.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 5n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 9999n, sweepCursor: 0, stakedCount: 0 }),
      receiptStatus: 'success',
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG, null);
    expect(rec.action).toBe('SWEEP');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('sweep');
    expect(rec.error).toBeUndefined();
    expect(rec.sweptEpochId).toBe(5n);
  });

  it('empty epoch (stakedCount==0) after sweep confirmed -> FINALIZE', async () => {
    // Same epoch, lastSweptEpochId already set to this epoch: decideAction should FINALIZE.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 5n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 9999n, sweepCursor: 0, stakedCount: 0 }),
      receiptStatus: 'success',
    });
    // Pass lastSweptEpochId = 5n (same as current epochId) -> should FINALIZE
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG, 5n);
    expect(rec.action).toBe('FINALIZE');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('finalizeSettle');
    expect(rec.error).toBeUndefined();
  });

  it('missed start window -> STUCK: no tx, loud error, tick is a failure', async () => {
    // now (Date.now()/1000) is far past entryCloseTime + maxStartDelay, so startEpoch
    // would revert StartDelayExceeded forever. The keeper must send NO tx.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.EntryOpen, entryCloseTime: 1n }),
      maxStartDelay: 1,
    });

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);

    expect(rec.action).toBe('STUCK');
    expect(writeContract).not.toHaveBeenCalled();
    expect(rec.txHash).toBeUndefined();
    expect(rec.error).toMatch(/start window missed/);
  });

  it('paused -> NONE: no write even when an action would otherwise fire', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 0n, endTime: 1n }), // would END
      paused: true,
    });

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG);

    expect(rec.action).toBe('NONE');
    expect(writeContract).not.toHaveBeenCalled();
    expect(rec.error).toBeUndefined();
  });
});

describe('runMarketOnce — OPTIONAL owner-key wedge auto-recovery', () => {
  // A genuinely WEDGED epoch: EntryOpen, the start window has lapsed vs the real
  // wall-clock (entryCloseTime + maxStartDelay both tiny), unresolved (settlePrice18==0),
  // and endTime far in the past so the on-chain GRACE window has already elapsed.
  // decideAction returns STUCK for this; with an owner key, decideRecovery -> RECOVER.
  const wedgedEpoch = () =>
    epochView({
      phase: PhaseView.EntryOpen,
      entryCloseTime: 1n,
      endTime: 1n, // endTime + GRACE(600) is far in the past -> grace elapsed
      settlePrice18: 0n,
    });

  // A wedged epoch whose grace has NOT elapsed: endTime is in the (near) future so
  // now <= endTime + GRACE. The start window is still missed (STUCK) because
  // entryClose+maxStartDelay are tiny, but emergencySettle would revert GraceNotElapsed.
  const wedgedNoGraceEpoch = () =>
    epochView({
      phase: PhaseView.EntryOpen,
      entryCloseTime: 1n,
      // endTime far enough ahead that now < endTime + 600 holds for any near-future run.
      endTime: BigInt(Math.floor(Date.now() / 1000) + 10_000),
      settlePrice18: 0n,
    });

  // (a) wedged + owner key + grace elapsed -> RECOVER via owner emergencySettle(RANGE).
  it('wedged + owner key + grace elapsed -> emergencySettle with the OWNER signer + RANGE', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      epoch: wedgedEpoch(),
      maxStartDelay: 1,
      receiptStatus: 'success',
    });
    const { owner, ownerWrite } = makeOwner();

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG, null, owner);

    expect(rec.action).toBe('STUCK'); // the decided action is still STUCK...
    expect(rec.error).toBeUndefined(); // ...but recovery cleared it -> not a failure
    expect(rec.recoveredEpochId).toBe(7n);
    expect(rec.txHash).toBe('0xrecover');

    // The KEEPER key must NEVER sign the recovery; only the OWNER wallet does.
    expect(writeContract).not.toHaveBeenCalled();
    expect(ownerWrite).toHaveBeenCalledOnce();
    const call = ownerWrite.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('emergencySettle');
    expect(call.args).toEqual([7n, 3]); // (epochId, RANGE)
    expect(call.account).toBe(ownerAccount); // signed by the owner account
    expect(call.maxFeePerGas).toBe(20_000_000_000n); // gas floor pinned like every write
  });

  // (b) wedged + NO owner key -> STUCK, unchanged (no tx at all).
  it('wedged + NO owner key -> STUCK (unchanged): no tx, loud error', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      epoch: wedgedEpoch(),
      maxStartDelay: 1,
    });

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG); // no owner

    expect(rec.action).toBe('STUCK');
    expect(writeContract).not.toHaveBeenCalled();
    expect(rec.txHash).toBeUndefined();
    expect(rec.recoveredEpochId).toBeUndefined();
    expect(rec.error).toMatch(/start window missed/);
  });

  // (c) wedged + owner key + grace NOT elapsed -> WAIT/back-off, NO emergencySettle tx.
  it('wedged + owner key + grace NOT elapsed -> back off, NO emergencySettle (no spam)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      epoch: wedgedNoGraceEpoch(),
      maxStartDelay: 1,
    });
    const { owner, ownerWrite } = makeOwner();

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG, null, owner);

    expect(rec.action).toBe('STUCK');
    expect(ownerWrite).not.toHaveBeenCalled(); // did NOT spam emergencySettle
    expect(writeContract).not.toHaveBeenCalled();
    expect(rec.txHash).toBeUndefined();
    expect(rec.recoveredEpochId).toBeUndefined();
    expect(rec.error).toMatch(/GRACE not yet elapsed/i); // recorded a failure -> backoff
  });

  // (d) healthy epoch + owner key present -> normal crank with the KEEPER key, NEVER owner.
  it('healthy epoch + owner key present -> normal crank uses the KEEPER key, owner UNUSED', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Idle }), // -> OPEN (normal lifecycle crank)
      receiptStatus: 'success',
    });
    const { owner, ownerWrite } = makeOwner();

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG, null, owner);

    expect(rec.action).toBe('OPEN');
    expect(rec.error).toBeUndefined();
    expect(rec.recoveredEpochId).toBeUndefined();
    // Normal crank signs with the KEEPER key; the owner wallet is NEVER touched.
    expect(writeContract).toHaveBeenCalledOnce();
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('openEntry');
    expect(ownerWrite).not.toHaveBeenCalled();
  });

  // SAFETY: a normal SETTLEMENT crank (sweep/finalize) with an owner key present must also
  // use the keeper key only — the owner path is unreachable for any non-STUCK state.
  it('Resolved (would SWEEP) + owner key -> keeper SWEEP, owner UNUSED', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochView({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 200 }),
      receiptStatus: 'success',
    });
    const { owner, ownerWrite } = makeOwner();

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG, null, owner);

    expect(rec.action).toBe('SWEEP');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('sweep');
    expect(ownerWrite).not.toHaveBeenCalled();
  });

  // A recovery tx that MINES-BUT-REVERTS (e.g. clock-skew GraceNotElapsed) is a FAILURE,
  // not a cleared wedge: rec.error is set so the loop backs off and retries.
  it('recovery emergencySettle mines-but-reverts -> tick is a FAILURE (backoff), not cleared', async () => {
    const { publicClient, walletClient } = makeClients({
      epochId: 7n,
      epoch: wedgedEpoch(),
      maxStartDelay: 1,
      receiptStatus: 'reverted',
    });
    const { owner, ownerWrite } = makeOwner();

    const rec = await runMarketOnce(publicClient, walletClient, account, chain, MARKET, CFG, null, owner);

    expect(rec.action).toBe('STUCK');
    expect(ownerWrite).toHaveBeenCalledOnce(); // it DID attempt the recovery
    expect(rec.txHash).toBe('0xrecover');
    expect(rec.recoveredEpochId).toBeUndefined(); // ...but it reverted
    expect(rec.error).toMatch(/emergencySettle reverted/i);
  });
});
