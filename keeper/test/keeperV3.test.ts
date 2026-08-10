import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runMarketOnceV3, aggregateSamples } from '../src/keeperV3.js';
import { PhaseViewV3 } from '../src/decideV3.js';
import { keccak256, encodePacked } from 'viem';
import type { KeeperConfig, MarketConfig } from '../src/config.js';

// Mirrors keeper.test.ts's stand-in pattern for the v3 (entry-anchored) crank.

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
  // tiny sampling window so the SETTLE test completes fast
  v3SampleSec: 1,
  v3SampleIntervalMs: 50,
};

const account = { address: '0x000000000000000000000000000000000000dEaD' } as never;
const chain = { id: 1 } as never;

type WriteArg = Record<string, unknown>;

/** Full v3 EpochView with overridable fields; defaults to mid-entry. */
function epochViewV3(over: Partial<Record<string, unknown>> = {}) {
  return {
    epochId: 1n,
    phase: PhaseViewV3.EntryOpen,
    entryOpenTime: 0n,
    entryCloseTime: 1000n,
    settlementTime: 1600n,
    settleTimeActual: 0n,
    bandBps: 150,
    rolledOver: false,
    stakedCount: 0,
    processedCursor: 0,
    winnerCount: 0,
    claimedCount: 0,
    finalPrice18: 0n,
    potBase: 0n,
    potUSDC: 0n,
    totalWinnerContribution: 0n,
    rolloverPendingIn: false,
    rolloverInBase: 0n,
    rolloverInUSDC: 0n,
    ...over,
  };
}

function makeClients(opts: {
  epochId: bigint;
  epoch: ReturnType<typeof epochViewV3>;
  paused?: boolean;
  updateFee?: bigint;
  lastSettledEpochId?: bigint;
  unstakeCursor?: number;
  processProgress?: readonly [number, number];
  receiptStatus?: 'success' | 'reverted';
  /** Gas the position cranks estimate. A number → that value; a fn → per-count (lets a test
   *  simulate the over-cap error). Defaults to a cheap 1M so batches keep their full size. */
  estimateGas?: bigint | ((count: number) => bigint);
}) {
  const writeContract = vi.fn(async (_req: WriteArg) => '0xabc' as `0x${string}`);
  const waitForTransactionReceipt = vi.fn(async () => ({ status: opts.receiptStatus ?? 'success' }));
  const estimateContractGas = vi.fn(async (req: { args?: readonly unknown[] }) => {
    const count = Number((req.args?.[1] as bigint | undefined) ?? 1n);
    const e = opts.estimateGas ?? 1_000_000n;
    return typeof e === 'function' ? e(count) : e;
  });
  const readContract = vi.fn(async (req: { functionName: string }) => {
    switch (req.functionName) {
      case 'currentEpochId':
        return opts.epochId;
      case 'currentEpoch':
        return opts.epoch;
      case 'paused':
        return opts.paused ?? false;
      case 'getUpdateFee':
        return opts.updateFee ?? 7n;
      case 'lastSettledEpochId':
        if (opts.lastSettledEpochId === undefined) throw new Error('unexpected read lastSettledEpochId');
        return opts.lastSettledEpochId;
      case 'unstakeCursor':
        if (opts.unstakeCursor === undefined) throw new Error('unexpected read unstakeCursor');
        return opts.unstakeCursor;
      case 'processProgress':
        if (opts.processProgress === undefined) throw new Error('unexpected read processProgress');
        return opts.processProgress;
      default:
        throw new Error(`unexpected read ${req.functionName}`);
    }
  });
  const publicClient = { readContract, waitForTransactionReceipt, estimateContractGas } as never;
  const walletClient = { writeContract } as never;
  return { publicClient, walletClient, writeContract, estimateContractGas };
}

/** Stub global fetch with a Hermes-shaped response: price 100,000 (1e13 * 10^-8 scale). */
function stubHermes(priceRaw = '10000000000000', expo = -8) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        binary: { data: ['aabbcc'] },
        parsed: [{ price: { price: priceRaw, expo, publish_time: 1_700_000_000 } }],
      }),
    })),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('aggregateSamples — pure settlement averaging', () => {
  it('averages and hashes the sampled prices', () => {
    const prices = [100_000n * 10n ** 18n, 100_010n * 10n ** 18n, 99_990n * 10n ** 18n];
    const s = aggregateSamples(prices, 1000, 1060);
    expect(s.avgPrice18).toBe(100_000n * 10n ** 18n);
    expect(s.count).toBe(3);
    expect(s.sampleStart).toBe(1000n);
    expect(s.sampleEnd).toBe(1060n);
    expect(s.samplesHash).toBe(keccak256(encodePacked(['uint256[]'], [prices])));
  });

  it('throws on an empty sample set', () => {
    expect(() => aggregateSamples([], 0, 0)).toThrow(/no settlement samples/);
  });
});

describe('runMarketOnceV3 — chooses & executes the right crank', () => {
  it('epochId 0 -> createEpoch', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 0n,
      epoch: epochViewV3({ phase: PhaseViewV3.Idle }),
      lastSettledEpochId: 0n,
    });
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('CREATE');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('createEpoch');
  });

  it('Idle -> openEntry', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochViewV3({ phase: PhaseViewV3.Idle }),
      lastSettledEpochId: 0n,
    });
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('OPEN');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('openEntry');
  });

  it('Locked past settlementTime -> samples Hermes and submits the anchored average', async () => {
    stubHermes(); // every sample reads 100,000 -> average 100,000e18
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 3n,
      epoch: epochViewV3({ epochId: 3n, phase: PhaseViewV3.Locked, settlementTime: 1n }), // long past
      lastSettledEpochId: 2n,
      unstakeCursor: 5,
      processProgress: [5, 5], // previous epoch fully returned
      updateFee: 9n,
    });
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('SETTLE');
    expect(rec.error).toBeUndefined();
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('submitSettlementPrice');
    const args = call.args as readonly unknown[];
    expect(args[0]).toBe(3n); // epochId
    expect(args[1]).toBe(100_000n * 10n ** 18n); // the sampled average
    expect(typeof args[4]).toBe('string'); // samplesHash
    expect(Array.isArray(args[5])).toBe(true); // fresh anchor blob
    expect(call.value).toBe(9n); // Pyth update fee
  });

  it('Settling with cursor<total -> processPositions fitted to the remaining backlog under the cap', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 3n,
      epoch: epochViewV3({ epochId: 3n, phase: PhaseViewV3.Settling, processedCursor: 1, stakedCount: 4 }),
      lastSettledEpochId: 2n,
      unstakeCursor: 5,
      processProgress: [5, 5],
    });
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('PROCESS');
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('processPositions');
    // remaining = 4 - 1 = 3; cheap estimate keeps all 3, with an explicit (sub-cap) gas-limit.
    expect(call.args).toEqual([3n, 3n]);
    expect(call.gas).toBe(1_125_000n); // 1M estimate + 12.5%
  });

  it('Settling: a heavy position that estimates OVER the cap shrinks to one-at-a-time at the cap (the 1658 wedge fix)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 3n,
      epoch: epochViewV3({ epochId: 3n, phase: PhaseViewV3.Settling, processedCursor: 0, stakedCount: 3 }),
      lastSettledEpochId: 2n,
      unstakeCursor: 5,
      processProgress: [5, 5],
      // The real Arc behavior: any batch > 1 estimates above the cap (errors); a single position
      // clamps to the cap. The keeper must NOT wedge — it shrinks to 1 and submits at the cap.
      estimateGas: (count) => {
        if (count > 1) throw new Error('gas required exceeds 16777216');
        return 16_777_216n;
      },
    });
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('PROCESS');
    expect(rec.error).toBeUndefined();
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('processPositions');
    expect(call.args).toEqual([3n, 1n]); // one position at a time
    expect(call.gas).toBe(16_777_216n); // submitted AT the cap (buffer clamped)
  });

  it('Settling fully processed -> finalizeEpoch', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 3n,
      epoch: epochViewV3({ epochId: 3n, phase: PhaseViewV3.Settling, processedCursor: 4, stakedCount: 4 }),
      lastSettledEpochId: 2n,
      unstakeCursor: 5,
      processProgress: [5, 5],
    });
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('FINALIZE');
    expect((writeContract.mock.calls[0]![0] as Record<string, unknown>).args).toEqual([3n]);
  });

  it('Settled with auto-return backlog -> unstakeBatch(lastSettled, SWEEP_BATCH)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 3n,
      epoch: epochViewV3({ epochId: 3n, phase: PhaseViewV3.Settled }),
      lastSettledEpochId: 3n,
      unstakeCursor: 1,
      processProgress: [4, 4], // 4 staked, only 1 returned
    });
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('UNSTAKE');
    const call = writeContract.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.functionName).toBe('unstakeBatch');
    // 4 staked, 1 returned -> 3 remaining; cheap estimate keeps all 3 under the cap.
    expect(call.args).toEqual([3n, 3n]);
    expect(call.gas).toBe(1_125_000n);
  });

  it('Settled fully drained -> createEpoch (next round)', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 3n,
      epoch: epochViewV3({ epochId: 3n, phase: PhaseViewV3.Settled }),
      lastSettledEpochId: 3n,
      unstakeCursor: 4,
      processProgress: [4, 4],
    });
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('CREATE');
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('createEpoch');
  });

  it('backlog reads reverting (fresh arena) leave the lifecycle unharmed', async () => {
    // No lastSettledEpochId in opts -> that read THROWS; the tick must still decide.
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 1n,
      epoch: epochViewV3({ phase: PhaseViewV3.Idle }),
    });
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('OPEN');
    expect(rec.error).toBeUndefined();
    expect((writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('openEntry');
  });

  it('captures errors instead of throwing out of the tick', async () => {
    const readContract = vi.fn(async () => {
      throw new Error('rpc down');
    });
    const publicClient = { readContract } as never;
    const walletClient = { writeContract: vi.fn() } as never;
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG);
    expect(rec.action).toBe('NONE');
    expect(rec.error).toMatch(/rpc down/);
  });

  it('OWNER SELF-HEAL: a stuck-unsettled epoch past grace -> emergencySettle via the owner wallet', async () => {
    // settlementTime=1 is long past, so nowSec (real clock) is well beyond settlementTime + GRACE.
    // epoch 3, lastSettled 2 -> current == lastSettled+1, EntryOpen -> the recoverable wedge shape.
    const { publicClient, walletClient } = makeClients({
      epochId: 3n,
      epoch: epochViewV3({ epochId: 3n, phase: PhaseViewV3.EntryOpen, settlementTime: 1n }),
      lastSettledEpochId: 2n,
      unstakeCursor: 5,
      processProgress: [5, 5],
    });
    const ownerWrite = vi.fn(async (_req: WriteArg) => '0xrecover' as `0x${string}`);
    const ownerWallet = { writeContract: ownerWrite } as never;
    const ownerAccount = { address: '0x000000000000000000000000000000000000beef' } as never;

    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG, undefined, {
      wallet: ownerWallet,
      account: ownerAccount,
    });

    expect(rec.action).toBe('RECOVER');
    expect(rec.error).toBeUndefined();
    expect(rec.recoveredEpochId).toBe(3n);
    // emergencySettle was signed by the OWNER wallet (one arg, no Side), not the keeper signer.
    const call = ownerWrite.mock.calls[0]![0] as { functionName: string; args: readonly unknown[]; account: { address: string } };
    expect(call.functionName).toBe('emergencySettle');
    expect(call.args).toEqual([3n]);
    expect(call.account.address).toBe('0x000000000000000000000000000000000000beef');
  });

  it('NO owner key: the same wedge surfaces normally (SETTLE attempt), never emergencySettle', async () => {
    const { publicClient, walletClient, writeContract } = makeClients({
      epochId: 3n,
      epoch: epochViewV3({ epochId: 3n, phase: PhaseViewV3.EntryOpen, settlementTime: 1n }),
      lastSettledEpochId: 2n,
      unstakeCursor: 5,
      processProgress: [5, 5],
    });
    stubHermes();
    const rec = await runMarketOnceV3(publicClient, walletClient, account, chain, MARKET, CFG); // no owner
    expect(rec.action).toBe('SETTLE');
    const fns = writeContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    expect(fns).not.toContain('emergencySettle');
  });
});
