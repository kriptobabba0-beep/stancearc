import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runMarketOnceV3,
  chainMayContinue,
  stateAdvancedV3,
  hintNextWakeMs,
  shouldPreSample,
  anchorWaitMs,
  resetPreSamplersForTests,
} from '../src/keeperV3.js';
import { PhaseViewV3, type KeeperStateV3 } from '../src/decideV3.js';
import type { KeeperConfig, MarketConfig } from '../src/config.js';

// Settlement-latency pipeline: pre-sampling ([T-window, T]), same-tick action chaining, and the
// adaptive wake hint. Mirrors keeperV3.test.ts's stand-in pattern, plus a MUTABLE world whose
// state ADVANCES on each write so a single tick can drain the whole pipeline.

const MARKET: MarketConfig = {
  id: 'cirbtc-v3',
  label: 'cirBTC / USDC (entry anchored)',
  arena: '0xEcb0161E74ad9381e42f3f9d51Bb08324bD17D5c',
  feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  version: 'v3',
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
  // tiny sampling window so a legacy-fallback SETTLE completes fast
  v3SampleSec: 1,
  v3SampleIntervalMs: 50,
};

const account = { address: '0x000000000000000000000000000000000000dEaD' } as never;
const chain = { id: 1 } as never;

/** A minimal KeeperStateV3 for the pure helpers; mid-entry by default. */
function stateV3(over: Partial<KeeperStateV3> = {}): KeeperStateV3 {
  return {
    currentEpochId: 1n,
    phase: PhaseViewV3.Locked,
    entryCloseTime: 1_000n,
    settlementTime: 1_600n,
    processedCursor: 0,
    stakedCount: 0,
    nowSec: 1_500n,
    paused: false,
    ...over,
  };
}

/**
 * MUTABLE on-chain world: every keeper write advances it exactly the way the contract would,
 * so a chained tick walks SETTLE -> PROCESS -> FINALIZE -> UNSTAKE -> CREATE -> OPEN in one call.
 * `advance:false` freezes it (writes land but change nothing) to pin the lagging-view guard.
 */
function makeWorld(opts: { stakedCount?: number; advance?: boolean } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const world = {
    epochId: 1n,
    phase: PhaseViewV3.Locked as number,
    entryCloseTime: BigInt(nowSec - 200),
    settlementTime: BigInt(nowSec - 100), // already due -> first decide is SETTLE
    stakedCount: opts.stakedCount ?? 2,
    processedCursor: 0,
    lastSettledEpochId: 0n,
    unstakeCursor: 0,
    unstakeTotal: 0,
  };
  const advance = opts.advance !== false;

  const epochView = () => ({
    epochId: world.epochId,
    phase: world.phase,
    entryOpenTime: 0n,
    entryCloseTime: world.entryCloseTime,
    settlementTime: world.settlementTime,
    settleTimeActual: 0n,
    bandBps: 150,
    rolledOver: false,
    stakedCount: world.stakedCount,
    processedCursor: world.processedCursor,
    winnerCount: 0,
    claimedCount: 0,
    finalPrice18: 0n,
    potBase: 0n,
    potUSDC: 0n,
    totalWinnerContribution: 0n,
    rolloverPendingIn: false,
    rolloverInBase: 0n,
    rolloverInUSDC: 0n,
  });

  const writeContract = vi.fn(async (req: { functionName?: string; args?: readonly unknown[] }) => {
    if (advance) {
      switch (req.functionName) {
        case 'submitSettlementPrice':
          world.phase = PhaseViewV3.Settling;
          break;
        case 'processPositions':
          world.processedCursor = Math.min(world.stakedCount, world.processedCursor + Number(req.args?.[1] ?? 0n));
          break;
        case 'finalizeEpoch':
          world.phase = PhaseViewV3.Settled;
          world.lastSettledEpochId = world.epochId;
          world.unstakeTotal = world.stakedCount;
          break;
        case 'unstakeBatch':
          world.unstakeCursor = Math.min(world.unstakeTotal, world.unstakeCursor + Number(req.args?.[1] ?? 0n));
          break;
        case 'createEpoch': {
          const t = Math.floor(Date.now() / 1000);
          world.epochId += 1n;
          world.phase = PhaseViewV3.Idle;
          world.entryCloseTime = BigInt(t + 300);
          world.settlementTime = BigInt(t + 600);
          world.stakedCount = 0;
          world.processedCursor = 0;
          break;
        }
        case 'openEntry':
          world.phase = PhaseViewV3.EntryOpen;
          break;
      }
    }
    return '0xabc' as `0x${string}`;
  });
  const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' as const }));
  const estimateContractGas = vi.fn(async () => 1_000_000n);
  const readContract = vi.fn(async (req: { functionName: string }) => {
    switch (req.functionName) {
      case 'currentEpochId':
        return world.epochId;
      case 'currentEpoch':
        return epochView();
      case 'paused':
        return false;
      case 'maxPriceAge':
        return 900;
      case 'getUpdateFee':
        return 7n;
      case 'lastSettledEpochId':
        return world.lastSettledEpochId;
      case 'unstakeCursor':
        return world.unstakeCursor;
      case 'processProgress':
        return [world.unstakeTotal, world.unstakeTotal] as const;
      default:
        throw new Error(`unexpected read ${req.functionName}`);
    }
  });
  const publicClient = { readContract, waitForTransactionReceipt, estimateContractGas } as never;
  const walletClient = { writeContract } as never;
  return { publicClient, walletClient, writeContract, world };
}

/** Stub global fetch with a Hermes-shaped response (price 100,000 at expo -8). */
function stubHermes(priceRaw = '10000000000000', expo = -8) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        binary: { data: ['aabbcc'] },
        parsed: [{ price: { price: priceRaw, expo, publish_time: Math.floor(Date.now() / 1000) + 3 } }],
      }),
    })),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPreSamplersForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetPreSamplersForTests();
});

describe('chainMayContinue — pure chain gate', () => {
  it('budget 0 disables chaining entirely', () => {
    expect(chainMayContinue(1, 10, 0, 24)).toBe(false);
  });
  it('continues inside both the step cap and the wall-clock budget', () => {
    expect(chainMayContinue(3, 10_000, 45_000, 24)).toBe(true);
  });
  it('stops at the step cap', () => {
    expect(chainMayContinue(24, 10_000, 45_000, 24)).toBe(false);
  });
  it('stops when the wall-clock budget is spent', () => {
    expect(chainMayContinue(3, 45_000, 45_000, 24)).toBe(false);
  });
});

describe('stateAdvancedV3 — pure lagging-view guard', () => {
  const base = stateV3({ lastSettledEpochId: 1n, unstakeDone: 0, unstakeTotal: 3 });
  it('identical reads did NOT advance', () => {
    expect(stateAdvancedV3(base, { ...base })).toBe(false);
  });
  it.each([
    ['epoch', { currentEpochId: 2n }],
    ['phase', { phase: PhaseViewV3.Settling }],
    ['processedCursor', { processedCursor: 1 }],
    ['unstakeDone', { unstakeDone: 2 }],
    ['lastSettledEpochId', { lastSettledEpochId: 2n }],
  ] as const)('%s moving counts as an advance', (_label, over) => {
    expect(stateAdvancedV3(base, { ...base, ...over })).toBe(true);
  });
  it('a backlog field APPEARING (undefined -> value) counts as an advance', () => {
    const prev = stateV3();
    expect(stateAdvancedV3(prev, { ...prev, unstakeDone: 0 })).toBe(true);
  });
});

describe('hintNextWakeMs — pure adaptive-wake hint', () => {
  it('before the pre-sample window: wakes at its start', () => {
    const s = stateV3({ settlementTime: 1_600n, nowSec: 1_400n });
    expect(hintNextWakeMs(s, 60, true)).toBe(140 * 1000 + 250); // 1600-60=1540; 1540-1400=140s
  });
  it('inside the pre-sample window: wakes at the settlement moment', () => {
    const s = stateV3({ settlementTime: 1_600n, nowSec: 1_550n });
    expect(hintNextWakeMs(s, 60, true)).toBe(50 * 1000 + 250);
  });
  it('pre-sampling disabled: wakes at the settlement moment', () => {
    const s = stateV3({ settlementTime: 1_600n, nowSec: 1_400n });
    expect(hintNextWakeMs(s, 60, false)).toBe(200 * 1000 + 250);
  });
  it('already due / wrong phase / paused: no hint', () => {
    expect(hintNextWakeMs(stateV3({ nowSec: 1_700n }), 60, true)).toBeUndefined();
    expect(hintNextWakeMs(stateV3({ phase: PhaseViewV3.Settling }), 60, true)).toBeUndefined();
    expect(hintNextWakeMs(stateV3({ paused: true }), 60, true)).toBeUndefined();
  });
});

describe('shouldPreSample — pure spawn eligibility', () => {
  it('arms only inside [T - window, T) of an entry/locked epoch', () => {
    expect(shouldPreSample(stateV3({ settlementTime: 1_600n, nowSec: 1_550n }), 60, true)).toBe(true);
    expect(shouldPreSample(stateV3({ settlementTime: 1_600n, nowSec: 1_500n }), 60, true)).toBe(false); // before window
    expect(shouldPreSample(stateV3({ settlementTime: 1_600n, nowSec: 1_600n }), 60, true)).toBe(false); // already due
  });
  it('never arms when disabled, paused, or out of the entry/lock phase', () => {
    const inWindow = stateV3({ settlementTime: 1_600n, nowSec: 1_550n });
    expect(shouldPreSample(inWindow, 60, false)).toBe(false);
    expect(shouldPreSample({ ...inWindow, paused: true }, 60, true)).toBe(false);
    expect(shouldPreSample({ ...inWindow, phase: PhaseViewV3.Settling }, 60, true)).toBe(false);
  });
});

describe('anchorWaitMs — pure anchor-freshness margin', () => {
  it('arriving AT the settlement moment waits out the full margin', () => {
    expect(anchorWaitMs(1_600n, 1_600_000, 2)).toBe(2_000);
  });
  it('arriving inside the margin waits only the remainder', () => {
    expect(anchorWaitMs(1_600n, 1_601_200, 2)).toBe(800);
  });
  it('the legacy late path (T+60s) never waits', () => {
    expect(anchorWaitMs(1_600n, 1_660_000, 2)).toBe(0);
  });
  it('margin 0 disables the wait entirely', () => {
    expect(anchorWaitMs(1_600n, 1_600_000, 0)).toBe(0);
  });
});

describe('runMarketOnceV3 — same-tick pipeline chaining', () => {
  it('drains SETTLE -> PROCESS -> FINALIZE -> UNSTAKE -> CREATE -> OPEN in ONE tick', async () => {
    stubHermes();
    const { publicClient, walletClient, writeContract, world } = makeWorld({ stakedCount: 2 });
    const cfg = { ...CFG, v3ChainBudgetMs: 30_000, v3ChainMaxSteps: 24 };

    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, cfg);

    const calls = writeContract.mock.calls.map((c) => (c[0] as { functionName?: string }).functionName);
    expect(calls).toEqual([
      'submitSettlementPrice',
      'processPositions',
      'finalizeEpoch',
      'unstakeBatch',
      'createEpoch',
      'openEntry',
    ]);
    expect(rec.error).toBeUndefined();
    expect(rec.action).toBe('OPEN'); // the last EXECUTED action anchors the loop's success path
    expect(rec.chainedActions).toBe(5);
    // The terminal idle read hints the loop at the NEW epoch's boundary (far future here).
    expect(rec.nextWakeMsHint).toBeGreaterThan(0);
    expect(world.phase).toBe(PhaseViewV3.EntryOpen);
    expect(world.epochId).toBe(2n);
  });

  it('a lagging view (state did not advance) ends the chain after ONE action — never re-fires', async () => {
    stubHermes();
    const { publicClient, walletClient, writeContract } = makeWorld({ advance: false });
    const cfg = { ...CFG, v3ChainBudgetMs: 30_000, v3ChainMaxSteps: 24 };

    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, cfg);

    expect(writeContract).toHaveBeenCalledTimes(1);
    expect((writeContract.mock.calls[0]![0] as { functionName?: string }).functionName).toBe('submitSettlementPrice');
    expect(rec.action).toBe('SETTLE');
    expect(rec.error).toBeUndefined();
  });

  it('budget 0 keeps the exact legacy one-action-per-tick cadence', async () => {
    stubHermes();
    const { publicClient, walletClient, writeContract } = makeWorld({ stakedCount: 2 });
    const cfg = { ...CFG, v3ChainBudgetMs: 0 };

    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, cfg);

    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(rec.action).toBe('SETTLE');
    expect(rec.chainedActions).toBeUndefined();
  });

  it('a mid-chain revert surfaces as THAT step\'s failure (breaker/backoff contract intact)', async () => {
    stubHermes();
    const { publicClient, walletClient, writeContract } = makeWorld({ stakedCount: 2 });
    // First write (settle) succeeds; the PROCESS receipt reverts.
    const wait = (publicClient as unknown as { waitForTransactionReceipt: ReturnType<typeof vi.fn> })
      .waitForTransactionReceipt;
    wait.mockImplementation(async () => {
      const lastFn = (writeContract.mock.calls.at(-1)?.[0] as { functionName?: string } | undefined)?.functionName;
      return { status: lastFn === 'processPositions' ? 'reverted' : 'success' };
    });
    const cfg = { ...CFG, v3ChainBudgetMs: 30_000 };

    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, cfg);

    expect(writeContract).toHaveBeenCalledTimes(2); // settle + the reverted process, nothing after
    expect(rec.action).toBe('PROCESS');
    expect(rec.error).toContain('tx reverted');
  });
});

describe('runMarketOnceV3 — settlement pre-sampling', () => {
  it('arms in the pre-window, then SETTLE submits the [T-window, T] average with presampled:true', async () => {
    stubHermes();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { publicClient, walletClient, writeContract, world } = makeWorld({ stakedCount: 0 });
    // Rewind the world to LOCKED with the settlement ~2s in the future: inside the pre-window.
    const t = Math.floor(Date.now() / 1000);
    world.settlementTime = BigInt(t + 2);
    world.entryCloseTime = BigInt(t - 10);
    const cfg = { ...CFG, v3PreSampleEnabled: true, v3SampleSec: 2, v3SampleIntervalMs: 50, v3ChainBudgetMs: 0 };

    // Tick 1 (pre-window): decides NONE, arms the background sampler, hints the boundary wake.
    const idle = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, cfg);
    expect(idle.action).toBe('NONE');
    expect(idle.nextWakeMsHint).toBeGreaterThan(0);
    expect(idle.nextWakeMsHint).toBeLessThanOrEqual(2_250);

    // Let the sampler run past the settlement moment, then settle.
    await new Promise((r) => setTimeout(r, 2_400));
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, cfg);

    expect(rec.action).toBe('SETTLE');
    expect(rec.error).toBeUndefined();
    expect((writeContract.mock.calls[0]![0] as { functionName?: string }).functionName).toBe('submitSettlementPrice');
    const settleLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('"msg":"keeper.v3.settle"'));
    expect(settleLine).toBeDefined();
    expect(settleLine).toContain('"presampled":true');
  }, 15_000);
});
