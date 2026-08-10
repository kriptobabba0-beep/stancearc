// keeperV2.test.ts — the v2 (PINNED) crank path in runMarketOnce. v2 differs from v1 ONLY
// in START/END: the contract pins the posted blob's publishTime into
// [endpointTime, endpointTime+settleWindow], so the keeper must (a) use the v2 ABI, (b) only
// ATTEMPT start/end while the wall clock is inside that window (else WAIT/MISSED), and (c)
// optionally fund the per-epoch subsidy with the owner key. v1 markets are unchanged
// (covered by keeper.test.ts). These tests drive the real wall clock by anchoring the
// epoch's startTime/endTime relative to Date.now().
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMarketOnce } from '../src/keeper.js';
import { PhaseView } from '../src/decide.js';
import { PhaseV2 } from '../src/decideV2.js';
import type { KeeperConfig, MarketConfig } from '../src/config.js';

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
  markets: [V2_MARKET],
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
const ownerAccount = { address: '0x0000000000000000000000000000000000000B0b' } as never;

function makeOwner() {
  const ownerWrite = vi.fn(async (_req: WriteArg) => '0xowner' as `0x${string}`);
  const owner = { account: ownerAccount, wallet: { writeContract: ownerWrite } as never };
  return { owner, ownerWrite };
}

const nowSec = () => Math.floor(Date.now() / 1000);

// A v2 EpochV2 view (the keeper only reads phase/entryCloseTime/startTime/endTime/
// settlePrice18/sweepCursor/stakedCount/subsidyUSDC — defaults cover the rest).
function epochV2(over: Partial<Record<string, unknown>> = {}) {
  return {
    phase: PhaseView.Running,
    entryOpenTime: 0n,
    entryCloseTime: 1000n,
    startTime: 1100n,
    endTime: BigInt(nowSec()), // default: end window is "now"
    startTimeActual: 0n,
    settleTimeActual: 0n,
    winningSide: 0,
    rolledOver: false,
    rolloverConsumed: false,
    sweepCursor: 0,
    stakedCount: 0,
    bandBps: 100,
    startPrice18: 3000n,
    settlePrice18: 0n,
    deltaBps: 0n,
    potWETH: 0n,
    potUSDC: 0n,
    sideContribution6: [0n, 0n, 0n, 0n],
    winnerDenominator: 0n,
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

function makeClients(opts: {
  epochId: bigint;
  epoch: ReturnType<typeof epochV2>;
  updateFee?: bigint;
  maxStartDelay?: number;
  paused?: boolean;
  settleWindow?: number;
  receiptStatus?: 'success' | 'reverted';
  // subsidy machinery
  usdc?: `0x${string}`;
  maxSubsidyPerEpoch?: bigint;
  allowance?: bigint;
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
        return opts.maxStartDelay ?? 0xffffffff; // window effectively always open by default
      case 'paused':
        return opts.paused ?? false;
      case 'settleWindow':
        return opts.settleWindow ?? 12;
      case 'getUpdateFee':
        return opts.updateFee ?? 7n;
      case 'USDC':
        return opts.usdc ?? '0x3600000000000000000000000000000000000000';
      case 'maxSubsidyPerEpoch':
        return opts.maxSubsidyPerEpoch ?? 150_000000n;
      case 'allowance':
        return opts.allowance ?? 0n;
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

describe('runMarketOnce v2 — uses the v2 ABI for non-settle cranks', () => {
  it('v2 epochId 0 -> createEpoch (v2 ABI)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 0n,
      epoch: epochV2({ phase: PhaseView.Idle }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('CREATE');
    expect(rec.error).toBeUndefined();
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('createEpoch');
  });

  it('v2 Idle -> openEntry', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.Idle }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('OPEN');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('openEntry');
  });

  it('v2 Resolved cursor<total -> sweep (same call, v2 ABI)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 200 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('SWEEP');
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('sweep');
    expect(call.args).toEqual([50n]);
  });

  it('v2 Resolved cursor==total -> finalizeSettle', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 200, stakedCount: 200 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('FINALIZE');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('finalizeSettle');
  });
});

describe('runMarketOnce v2 — PINNED start/end window gating', () => {
  it('END inside the window -> posts endEpoch with a fresh blob + fee (ATTEMPT)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ binary: { data: ['cc'] } }) })));
    // endTime = now -> inside [now, now+12-2]; ATTEMPT.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.Running, settlePrice18: 0n, endTime: BigInt(nowSec()) }),
      settleWindow: 12,
      updateFee: 9n,
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('END');
    expect(rec.windowState).toBeUndefined();
    expect(rec.error).toBeUndefined();
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('endEpoch');
    expect(call.value).toBe(9n);
    expect(call.args).toEqual([['0xcc']]);
  });

  it('END before the window opens is impossible here (decideAction gates END on endTime), but a WAIT arises for START before startTime within EntryOpen', async () => {
    // EntryOpen with entryClose in the past (so decideAction -> START) but startTime in the
    // FUTURE -> the pinned window has not opened yet -> WAIT (no tx, not a failure).
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ binary: { data: ['aa'] } }) })));
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochV2({
        phase: PhaseView.EntryOpen,
        entryCloseTime: 1n, // entry closed long ago -> decideAction returns START
        startTime: BigInt(nowSec() + 1000), // window opens far in the future
      }),
      settleWindow: 12,
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('START');
    expect(rec.windowState).toBe('WAIT');
    expect(rec.error).toBeUndefined(); // WAIT is a no-op success
    expect(writeContract).not.toHaveBeenCalled(); // NO post outside the window
  });

  it('END past the safe tail -> MISSED: no tx, recorded as a FAILURE (backoff/alert)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ binary: { data: ['dd'] } }) })));
    // endTime far in the past so now > endTime + settleWindow -> MISSED.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.Running, settlePrice18: 0n, endTime: BigInt(nowSec() - 100) }),
      settleWindow: 12,
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('END');
    expect(rec.windowState).toBe('MISSED');
    expect(rec.error).toMatch(/window missed/i);
    expect(writeContract).not.toHaveBeenCalled(); // never posts a doomed out-of-window blob
  });

  it('START inside the window -> posts startEpoch (v2, bytes[] only — contract pins the window)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ binary: { data: ['ee'] } }) })));
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochV2({
        phase: PhaseView.EntryOpen,
        entryCloseTime: 1n,
        startTime: BigInt(nowSec()), // window open now
      }),
      settleWindow: 12,
      updateFee: 5n,
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('START');
    expect(rec.windowState).toBeUndefined();
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('startEpoch');
    // v2 startEpoch takes ONLY bytes[] (contract computes min/max internally).
    expect(call.args).toEqual([['0xee']]);
    expect(call.value).toBe(5n);
  });

  it('an out-of-window REVERT on an ATTEMPT is handled like any mined-revert (tick FAILURE -> retry)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ binary: { data: ['ff'] } }) })));
    const { publicClient, walletClient } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.Running, settlePrice18: 0n, endTime: BigInt(nowSec()) }),
      settleWindow: 12,
      receiptStatus: 'reverted', // parsePriceFeedUpdates reverted (blob raced out of window)
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('END');
    expect(rec.error).toBe('tx reverted: END');
  });
});

describe('runMarketOnce v2 — OPTIONAL per-epoch subsidy (owner key)', () => {
  const FUNDED = { ...V2_MARKET, subsidyPerEpoch: 150_000000n };

  it('v2 + subsidy + owner key, EntryOpen pre-start -> approves USDC then fundSubsidy (owner key)', async () => {
    // EntryOpen, entry NOT yet closed -> decideAction NONE; subsidy still funds (phase<Resolved).
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.EntryOpen, entryCloseTime: BigInt(nowSec() + 1000), subsidyUSDC: 0n }),
      allowance: 0n, // needs approve
    });
    const { owner, ownerWrite } = makeOwner();
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, FUNDED, CFG, null, owner);

    expect(rec.action).toBe('NONE'); // entry not closed yet
    expect(rec.fundedSubsidyEpochId).toBe(1n);
    // Owner key signed BOTH the approve and the fundSubsidy; keeper key untouched.
    expect(writeContract).not.toHaveBeenCalled();
    const fns = ownerWrite.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    expect(fns).toEqual(['approve', 'fundSubsidy']);
    const fund = ownerWrite.mock.calls.find((c) => (c[0] as { functionName: string }).functionName === 'fundSubsidy')![0] as Record<string, unknown>;
    expect(fund.args).toEqual([1n, 150_000000n]); // (epochId, amount)
    expect(fund.account).toBe(ownerAccount);
  });

  it('skips approve when allowance already covers the top-up', async () => {
    const { publicClient, walletClient } = makeClients({
      epochId: 2n,
      epoch: epochV2({ phase: PhaseView.EntryOpen, entryCloseTime: BigInt(nowSec() + 1000), subsidyUSDC: 0n }),
      allowance: 10_000_000000n, // plenty
    });
    const { owner, ownerWrite } = makeOwner();
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, FUNDED, CFG, null, owner);
    expect(rec.fundedSubsidyEpochId).toBe(2n);
    const fns = ownerWrite.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    expect(fns).toEqual(['fundSubsidy']); // no approve
  });

  it('already funded to target -> no fundSubsidy (idempotent across restarts)', async () => {
    const { publicClient, walletClient } = makeClients({
      epochId: 3n,
      epoch: epochV2({ phase: PhaseView.EntryOpen, entryCloseTime: BigInt(nowSec() + 1000), subsidyUSDC: 150_000000n }),
      allowance: 10_000_000000n,
    });
    const { owner, ownerWrite } = makeOwner();
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, FUNDED, CFG, null, owner);
    expect(rec.fundedSubsidyEpochId).toBeUndefined();
    expect(ownerWrite).not.toHaveBeenCalled();
  });

  it('partially funded -> tops up only the REMAINING amount', async () => {
    const { publicClient, walletClient } = makeClients({
      epochId: 4n,
      epoch: epochV2({ phase: PhaseView.EntryOpen, entryCloseTime: BigInt(nowSec() + 1000), subsidyUSDC: 50_000000n }),
      allowance: 10_000_000000n,
    });
    const { owner, ownerWrite } = makeOwner();
    await runMarketOnce(publicClient, walletClient, account, chain, FUNDED, CFG, null, owner);
    const fund = ownerWrite.mock.calls.find((c) => (c[0] as { functionName: string }).functionName === 'fundSubsidy')![0] as Record<string, unknown>;
    expect(fund.args).toEqual([4n, 100_000000n]); // 150 - 50 already committed
  });

  it('clamps the top-up to the arena maxSubsidyPerEpoch', async () => {
    // Configure 200 USDC but the arena caps at 150 -> top-up clamped to 150.
    const OVER = { ...V2_MARKET, subsidyPerEpoch: 200_000000n };
    const { publicClient, walletClient } = makeClients({
      epochId: 5n,
      epoch: epochV2({ phase: PhaseView.EntryOpen, entryCloseTime: BigInt(nowSec() + 1000), subsidyUSDC: 0n }),
      maxSubsidyPerEpoch: 150_000000n,
      allowance: 10_000_000000n,
    });
    const { owner, ownerWrite } = makeOwner();
    await runMarketOnce(publicClient, walletClient, account, chain, OVER, CFG, null, owner);
    const fund = ownerWrite.mock.calls.find((c) => (c[0] as { functionName: string }).functionName === 'fundSubsidy')![0] as Record<string, unknown>;
    expect(fund.args).toEqual([5n, 150_000000n]);
  });

  it('NO owner key -> subsidy is a no-op (fundSubsidy is onlyOwner)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.EntryOpen, entryCloseTime: BigInt(nowSec() + 1000), subsidyUSDC: 0n }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, FUNDED, CFG); // no owner
    expect(rec.fundedSubsidyEpochId).toBeUndefined();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('no subsidy configured -> no fundSubsidy even with an owner key', async () => {
    const { publicClient, walletClient } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.EntryOpen, entryCloseTime: BigInt(nowSec() + 1000), subsidyUSDC: 0n }),
    });
    const { owner, ownerWrite } = makeOwner();
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG, null, owner);
    expect(rec.fundedSubsidyEpochId).toBeUndefined();
    expect(ownerWrite).not.toHaveBeenCalled();
  });

  it('Resolved epoch (phase>=Resolved) -> no fundSubsidy (would revert WrongPhase)', async () => {
    const { publicClient, walletClient } = makeClients({
      epochId: 1n,
      // Running WITH settlePrice18 != 0 == internal Resolved -> not fundable.
      epoch: epochV2({ phase: PhaseView.Running, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 5, subsidyUSDC: 0n }),
      allowance: 10_000_000000n,
    });
    const { owner, ownerWrite } = makeOwner();
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, FUNDED, CFG, null, owner);
    expect(rec.action).toBe('SWEEP'); // normal settlement crank proceeds
    expect(rec.fundedSubsidyEpochId).toBeUndefined();
    // Owner key NOT used for fundSubsidy; the SWEEP uses the keeper key.
    expect(ownerWrite).not.toHaveBeenCalled();
  });

  it('a fundSubsidy REVERT does NOT fail the lifecycle tick (best-effort)', async () => {
    // OPEN action succeeds (keeper key) but the subsidy fundSubsidy reverts -> rec.error stays
    // undefined (the lifecycle crank is healthy); the subsidy error is logged, not fatal.
    const { publicClient, walletClient } = makeClients({
      epochId: 1n,
      epoch: epochV2({ phase: PhaseView.Idle, subsidyUSDC: 0n }), // -> OPEN
      allowance: 10_000_000000n,
      receiptStatus: 'reverted', // every write (incl. fundSubsidy) reverts in this client...
    });
    // ...but we want OPEN to succeed and only fundSubsidy to revert. Use a custom wallet for the
    // keeper OPEN (success) and the owner wallet (reverted) so the two are independent.
    const keeperWrite = vi.fn(async (_r: WriteArg) => '0xopen' as `0x${string}`);
    const successWallet = { writeContract: keeperWrite } as never;
    // Override waitForTransactionReceipt to succeed for the keeper's OPEN tx, revert for owner's.
    (publicClient as { waitForTransactionReceipt: ReturnType<typeof vi.fn> }).waitForTransactionReceipt =
      vi.fn(async (req: { hash: `0x${string}` }) => ({ status: req.hash === '0xopen' ? 'success' : 'reverted' }));
    const { owner } = makeOwner();
    const rec = await runMarketOnce(publicClient, successWallet, account, chain, FUNDED, CFG, null, owner);
    expect(rec.action).toBe('OPEN');
    expect(rec.error).toBeUndefined(); // lifecycle crank healthy despite the subsidy revert
    expect(rec.fundedSubsidyEpochId).toBeUndefined(); // ...subsidy did NOT succeed
  });
});

// ===========================================================================
// CRITICAL — RAW v2 PHASE through the read path. The REAL FeeArenaV2.currentEpoch() returns
// the RAW EpochV2 struct with the INTERNAL 6-phase Phase enum (None=0/EntryOpen=1/Running=2/
// Resolved=3/Swept=4/Settled=5). It does NOT collapse to PhaseView (unlike v1). These tests
// therefore feed the RAW Phase VALUES the contract actually emits — NOT the collapsed-space
// values the older v2 tests above mock (phase=PhaseView.Running + settlePrice18 to fake
// "Resolved", which the real contract NEVER does) — and assert the keeper collapses them
// before decideAction so the lifecycle does NOT wedge at first settle.
// ===========================================================================
describe('runMarketOnce v2 — RAW internal Phase through the read path (the wedge fix)', () => {
  it('RAW Resolved(3), cursor<total -> SWEEP (NOT CREATE — the wedge bug)', async () => {
    // The contract sets phase=Phase.Resolved=3 (+ settlePrice18) after endEpoch. Pre-fix the
    // keeper read 3 as PhaseView.Settled -> decideAction returned CREATE -> createEpoch reverts
    // PrevNotSettled and winners are NEVER paid. With the collapse, 3 -> Running -> SWEEP.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      epoch: epochV2({ phase: PhaseV2.Resolved, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 200 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('SWEEP');
    expect(rec.error).toBeUndefined();
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('sweep');
  });

  it('RAW Resolved(3), EMPTY epoch (cursor==0==total), not yet swept -> SWEEP', async () => {
    // An empty Resolved epoch still needs ONE sweep() (Resolved->Swept) before finalize.
    const { publicClient, walletClient } = makeClients({
      epochId: 7n,
      epoch: epochV2({ phase: PhaseV2.Resolved, settlePrice18: 3100n, sweepCursor: 0, stakedCount: 0 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG, null);
    expect(rec.action).toBe('SWEEP'); // lastSweptEpochId=null -> first sweep of the empty epoch
    expect(rec.error).toBeUndefined();
  });

  it('RAW Swept(4), cursor==total -> FINALIZE (NOT NONE — pre-fix Swept fell through to NONE)', async () => {
    // After the sweep drains, the contract sets phase=Phase.Swept=4. Pre-fix the keeper read 4
    // (outside PhaseView's 0..3) -> default NONE -> finalizeSettle was NEVER called. With the
    // collapse, 4 -> Running, and settlePrice18!=0 + cursor==total -> FINALIZE.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      epoch: epochV2({ phase: PhaseV2.Swept, settlePrice18: 3100n, sweepCursor: 200, stakedCount: 200 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('FINALIZE');
    expect(rec.error).toBeUndefined();
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('finalizeSettle');
  });

  it('RAW Settled(5) -> CREATE the next epoch (NOT NONE — pre-fix Settled(5) was out of range)', async () => {
    // finalizeSettle sets phase=Phase.Settled=5 (claim/unstake open). Pre-fix the keeper read 5
    // (outside PhaseView's 0..3) -> default NONE -> the NEXT epoch was NEVER created (cycle dead).
    // With the collapse, 5 -> Settled -> CREATE.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      epoch: epochV2({ phase: PhaseV2.Settled, settlePrice18: 3100n, sweepCursor: 200, stakedCount: 200 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('CREATE');
    expect(rec.error).toBeUndefined();
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('createEpoch');
  });

  it('RAW None(0) -> OPEN (created-but-not-opened collapses to Idle)', async () => {
    // currentEpochId != 0 but the slot is Phase.None=0 (created, entry not opened) -> Idle -> OPEN.
    const { publicClient, walletClient } = makeClients({
      epochId: 7n,
      epoch: epochV2({ phase: PhaseV2.None }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('OPEN');
  });

  it('REGRESSION GUARD: this RAW Resolved(3) fixture would return CREATE if the collapse were removed', async () => {
    // This is the test that FAILS if collapseV2Phase is dropped from the v2 read path: a raw
    // Resolved(3) passed through `Number(phase) as PhaseView` is PhaseView.Settled -> CREATE.
    // With the collapse in place it MUST be the settle action (SWEEP), never CREATE.
    const { publicClient, walletClient } = makeClients({
      epochId: 9n,
      epoch: epochV2({ phase: PhaseV2.Resolved, settlePrice18: 4200n, sweepCursor: 1, stakedCount: 50 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V2_MARKET, CFG);
    expect(rec.action).toBe('SWEEP');
    expect(rec.action).not.toBe('CREATE'); // <- the explicit anti-wedge assertion
  });

  it('v1 market is UNCHANGED: a phase=3 from v1 currentEpoch() (already collapsed) stays Settled -> CREATE', async () => {
    // v1's currentEpoch() runs EpochViewLib.collapse, so its phase=3 IS PhaseView.Settled and the
    // keeper must NOT double-collapse it. Prove the v1 path still treats 3 as Settled -> CREATE.
    const V1_MARKET: MarketConfig = { ...V2_MARKET, id: 'eth-v1', version: 'v1' };
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 7n,
      // v1 currentEpoch() returns the COLLAPSED view: phase=PhaseView.Settled=3 means Settled.
      epoch: epochV2({ phase: PhaseView.Settled, settlePrice18: 3100n, sweepCursor: 200, stakedCount: 200 }),
    });
    const rec = await runMarketOnce(publicClient, walletClient, account, chain, V1_MARKET, CFG);
    expect(rec.action).toBe('CREATE'); // NOT double-collapsed to Running
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('createEpoch');
  });
});
