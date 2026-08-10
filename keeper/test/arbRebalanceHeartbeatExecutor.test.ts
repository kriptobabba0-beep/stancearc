import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runArbOnce } from '../src/arb.js';
import { price18ToSqrtPriceX96 } from '../src/poolMath.js';
import { snapshotHeartbeat, freshHeartbeatLedger } from '../src/heartbeat.js';
import type { ArbConfig } from '../src/config.js';
import type { Account, Chain, PublicClient, WalletClient } from 'viem';

// ---------------------------------------------------------------------------
// TASK 3 — executor integration for REBALANCE + HEARTBEAT swaps through runArbOnce, with
// MOCKED viem clients (same style as arbExecutor.test.ts). Proves:
//   (b) a heartbeat snapshot at ZERO divergence produces a heartbeat-purpose SwapRouter swap;
//   (a) a depleted-leg inventory produces a rebalance-purpose SwapRouter swap at zero div;
//   (c) NEITHER ever stakes the arena — every write is approve/exactInputSingle at the router.
// ---------------------------------------------------------------------------

const ONE18 = 10n ** 18n;
const REF18 = 100_000n * ONE18; // 100,000 USDC per cirBTC, 18dp

const OWNER = '0x000000000000000000000000000000000000000a' as `0x${string}`;
const ROUTER = '0x7fcEF1330B4C21f884D6894f3d6a56036E587aA9' as `0x${string}`;
const BASE = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' as `0x${string}`; // cirBTC (token1)
const QUOTE = '0x3600000000000000000000000000000000000000' as `0x${string}`; // USDC (token0)
const POOL = '0x0000000000000000000000000000000000000005' as `0x${string}`;
const ARENA = '0x000000000000000000000000000000000000dEaD' as `0x${string}`;
const MAX_UINT256 = (1n << 256n) - 1n;
const BASE_IS_TOKEN0 = false;

const market: ArbConfig['market'] = {
  id: 'cirbtc',
  label: 'cirBTC / USDC',
  arena: ARENA,
  pool: POOL,
  base: BASE,
  baseDecimals: 8,
  quote: QUOTE,
  quoteDecimals: 6,
  feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  router: ROUTER,
  feeTier: 3000,
};

// Base config with rebalancing + heartbeat ENABLED (small, bounded budgets).
const CFG: ArbConfig = {
  rpcUrl: 'http://localhost:8545',
  rpcUrls: ['http://localhost:8545'],
  privateKey: `0x${'1'.repeat(64)}`,
  hermesUrl: 'https://hermes.pyth.network',
  market,
  params: {
    feeBps: 30,
    thresholdBps: 25,
    closeFraction: 0.6,
    maxTradeBase: 10n ** 8n * 100n, // 100 base cap
    minTradeBase: 1_000n, // 0.00001 base dust floor
    reserveBase: 0n,
    reserveQuote: 0n,
    maxRefAgeSec: 60,
    slippageBps: 75,
    rebalanceFloorBps: 1500, // restock a leg below 15% of value
    rebalanceTargetBps: 5_000, // toward 50/50
    rebalanceMaxBase: 10n ** 8n * 100n,
    rebalanceIntervalMs: 0, // no interval guard for these focused single-tick tests
    rebalanceDailyMaxAttempts: 0,
    heartbeatEnabled: true,
    heartbeatIntervalMs: 60_000,
    heartbeatDailyCapBase: 10n ** 8n, // 1 base/day
    heartbeatTradeBase: 10n ** 6n, // 0.01 base/leg
    heartbeatDailyMaxAttempts: 0,
  },
  pollIntervalMs: 15_000,
  gasFloorWei: 20_000_000_000n,
  hermesTimeoutMs: 8_000,
  receiptTimeoutMs: 90_000,
  lowBalanceWei: 500_000_000_000_000_000n,
  // Gas escalation OFF (maxAttempts 0) -> the unchanged single floor-priced swap send.
  gasEscalation: { floorWei: 20_000_000_000n, capWei: 100_000_000_000n, multiplierBps: 12_500, maxAttempts: 0 },
  baseBackoffMs: 5_000,
  maxBackoffMs: 300_000,
  wedgedAlertThreshold: 5,
  httpPort: 0,
  httpHost: '127.0.0.1',
  stallFactor: 3,
  metricsPersistIntervalMs: 30_000,
  alert: { dedupeWindowMs: 900_000, heartbeatIntervalMs: 300_000, timeoutMs: 5_000 },
};

const account = { address: OWNER } as Account;
const chain = { id: 1234 } as Chain;

const slot0Of = (sqrtPriceX96: bigint) => [sqrtPriceX96, 0, 0, 1, 1, 0, true] as const;
const SQRT_REF = price18ToSqrtPriceX96(REF18, 8, 6, BASE_IS_TOKEN0); // pool == ref => zero divergence
const PYTH_PRICE = REF18 / 10n ** 10n; // expo -8

function stubHermes(publishTimeSec: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        binary: { data: ['00'] },
        parsed: [
          { id: market.feedId.slice(2), price: { price: PYTH_PRICE.toString(), conf: '1', expo: -8, publish_time: publishTimeSec } },
        ],
      }),
    })),
  );
}

type ReadReq = { address: string; functionName: string; args?: unknown[] };
type WriteReq = { address: string; functionName: string; args?: unknown[] };

function makeClients(opts: { liquidity: bigint; balances?: { base?: bigint; quote?: bigint } }) {
  const baseBal = opts.balances?.base ?? 10n ** 8n * 1_000n;
  const quoteBal = opts.balances?.quote ?? 10n ** 6n * 100_000_000n;
  const writeCalls: WriteReq[] = [];

  const readContract = vi.fn(async (req: ReadReq) => {
    switch (req.functionName) {
      case 'token0':
        return QUOTE;
      case 'slot0':
        return slot0Of(SQRT_REF); // always at ref => zero divergence
      case 'liquidity':
        return opts.liquidity;
      case 'balanceOf': {
        const token = (req.address as string).toLowerCase();
        if (token === BASE.toLowerCase()) return baseBal;
        if (token === QUOTE.toLowerCase()) return quoteBal;
        return 0n;
      }
      case 'allowance':
        return MAX_UINT256; // pre-approved so only the swap write occurs
      default:
        throw new Error(`unexpected read ${req.functionName}`);
    }
  });

  const writeContract = vi.fn(async (req: WriteReq) => {
    writeCalls.push(req);
    if (req.functionName === 'exactInputSingle') return ('0x' + 'f1'.repeat(32)) as `0x${string}`;
    if (req.functionName === 'approve') return ('0x' + 'a1'.repeat(32)) as `0x${string}`;
    throw new Error(`unexpected write ${req.functionName}`);
  });

  const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' as const }));

  const client = { readContract, waitForTransactionReceipt } as unknown as PublicClient;
  const wallet = { writeContract } as unknown as WalletClient;
  return { client, wallet, writeCalls };
}

const FRESH = () => Math.floor(Date.now() / 1000) - 5;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('arb executor — TASK 3b heartbeat swap at zero divergence', () => {
  it('emits a heartbeat-purpose SwapRouter swap when enabled + budgeted (pool == ref)', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls } = makeClients({ liquidity: 5n * 10n ** 15n });
    const ledger = freshHeartbeatLedger(Date.now());
    const snap = snapshotHeartbeat(ledger, Date.now());

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0, snap);

    expect(rec.kind).toBe('SWAP');
    expect(rec.purpose).toBe('heartbeat');
    expect(rec.error).toBeUndefined();
    const swap = writeCalls.find((w) => w.functionName === 'exactInputSingle')!;
    expect(swap.address).toBe(ROUTER); // routed at the SwapRouter, never the arena
  });

  it('does NOT emit a heartbeat when NO snapshot is injected (mode off for the tick) -> NONE', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls } = makeClients({ liquidity: 5n * 10n ** 15n });
    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0); // no snapshot
    expect(rec.kind).toBe('NONE');
    expect(writeCalls.length).toBe(0); // no swap broadcast
  });

  it('does NOT fire a heartbeat before the interval elapses -> NONE', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls } = makeClients({ liquidity: 5n * 10n ** 15n });
    const now = Date.now();
    // last heartbeat 1s ago, interval is 60s -> too soon.
    const snap = snapshotHeartbeat({ dayStartMs: now, spentTodayBase: 0n, lastHeartbeatMs: now - 1_000, heartbeatAttemptsToday: 0, lastRebalanceMs: null, rebalanceAttemptsToday: 0 }, now);
    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0, snap);
    expect(rec.kind).toBe('NONE');
    expect(writeCalls.length).toBe(0);
  });
});

describe('arb executor — TASK 3a rebalance swap at zero divergence', () => {
  it('emits a rebalance-purpose SwapRouter swap when a leg is depleted (pool == ref)', async () => {
    stubHermes(FRESH());
    // Base depleted: 1 base ($100k) vs 9,000,000 USDC -> base far below the 15% floor.
    const { client, wallet, writeCalls } = makeClients({
      liquidity: 5n * 10n ** 15n,
      balances: { base: 10n ** 8n, quote: 9_000_000n * 10n ** 6n },
    });
    // Heartbeat snapshot injected too, but rebalance must take priority.
    const snap = snapshotHeartbeat(freshHeartbeatLedger(Date.now()), Date.now());
    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0, snap);

    expect(rec.kind).toBe('SWAP');
    expect(rec.purpose).toBe('rebalance');
    expect(rec.direction).toBe('BUY_BASE'); // restock the depleted base leg
    const swap = writeCalls.find((w) => w.functionName === 'exactInputSingle')!;
    expect(swap.address).toBe(ROUTER);
  });
});

describe('arb executor — TASK 3c rebalance/heartbeat NEVER stake the arena', () => {
  it('every write across a rebalance + a heartbeat tick targets a token or the router — never the arena', async () => {
    stubHermes(FRESH());
    // First a rebalance tick (base depleted), then a heartbeat tick (balanced).
    const reb = makeClients({
      liquidity: 5n * 10n ** 15n,
      balances: { base: 10n ** 8n, quote: 9_000_000n * 10n ** 6n },
    });
    await runArbOnce(reb.client, reb.wallet, account, chain, CFG, BASE_IS_TOKEN0, snapshotHeartbeat(freshHeartbeatLedger(Date.now()), Date.now()));

    const hb = makeClients({ liquidity: 5n * 10n ** 15n });
    await runArbOnce(hb.client, hb.wallet, account, chain, CFG, BASE_IS_TOKEN0, snapshotHeartbeat(freshHeartbeatLedger(Date.now()), Date.now()));

    for (const w of [...reb.writeCalls, ...hb.writeCalls]) {
      expect(['approve', 'exactInputSingle']).toContain(w.functionName);
      expect(w.functionName).not.toBe('stake');
      expect(w.address.toLowerCase()).not.toBe(ARENA.toLowerCase());
      expect([BASE.toLowerCase(), QUOTE.toLowerCase(), ROUTER.toLowerCase()]).toContain(w.address.toLowerCase());
    }
  });
});
