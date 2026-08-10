import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runArbOnce,
  ensureRouterApprovals,
  resolveBaseIsToken0,
  buildSwapArgs,
} from '../src/arb.js';
import { price18ToSqrtPriceX96 } from '../src/poolMath.js';
import type { ArbConfig } from '../src/config.js';
import type { Account, Chain, PublicClient, WalletClient } from 'viem';

// ---------------------------------------------------------------------------
// INTEGRATION test for the price-keeper ARB executor (arb.ts).
//
// The pure decision (decideArb) and the pure swap-arg builder (buildSwapArgs) are unit
// tested elsewhere. This file drives the LIVE-SWAP path of runArbOnce + ensureRouterApprovals
// END-TO-END with MOCKED viem public/wallet clients and a MOCKED SwapRouter (no live RPC,
// no real chain), matching the existing keeper test style (vi.fn read/write stubs + a
// vi.stubGlobal('fetch') Hermes stub that exercises the real fetchPythRef parser).
//
// Coverage:
//   (a) router approvals are ensured BEFORE any swap, and skipped when already sufficient;
//   (b) a decided trade calls SwapRouter.exactInputSingle with the expected token-in/out,
//       amount, and a SANE sqrtPriceLimit (pinned to the ref => an UNDERSHOOT bound that
//       can't overshoot or partial-fill-revert);
//   (c) the post-swap watchdog distinguishes a successful swap (status 'success', the pool
//       is re-read and postSwapDivBps is recorded) from a reverted/empty swap (status
//       'reverted' => rec.error set, NO post-swap measurement);
//   (d) the executor NEVER stakes the arena — it only ever writes approve / exactInputSingle.
// ---------------------------------------------------------------------------

const ONE18 = 10n ** 18n;
const REF18 = 100_000n * ONE18; // 100,000 USDC per cirBTC, 18dp

const OWNER = '0x000000000000000000000000000000000000000a' as `0x${string}`;
const ROUTER = '0x7fcEF1330B4C21f884D6894f3d6a56036E587aA9' as `0x${string}`;
// cirBTC(0xf0C4..) > USDC(0x3600..) so token0 = USDC, token1 = cirBTC => baseIsToken0 = false.
const BASE = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' as `0x${string}`;
const QUOTE = '0x3600000000000000000000000000000000000000' as `0x${string}`;
const POOL = '0x0000000000000000000000000000000000000005' as `0x${string}`;

const MAX_UINT256 = (1n << 256n) - 1n;

const market: ArbConfig['market'] = {
  id: 'cirbtc',
  label: 'cirBTC / USDC',
  arena: '0x000000000000000000000000000000000000dEaD',
  pool: POOL,
  base: BASE,
  baseDecimals: 8,
  quote: QUOTE,
  quoteDecimals: 6,
  feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  router: ROUTER,
  feeTier: 3000,
};

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
    maxTradeBase: 10n ** 8n * 100n, // cap at 100 base
    minTradeBase: 1_000n,
    reserveBase: 0n,
    reserveQuote: 0n,
    maxRefAgeSec: 60,
    slippageBps: 75,
    // TASK 3 — rebalancing + heartbeat OFF here so the executor SWAP-path assertions below
    // exercise the unchanged price-convergence arb (purpose 'arb').
    rebalanceFloorBps: 0,
    rebalanceTargetBps: 5_000,
    rebalanceMaxBase: 10n ** 8n * 100n,
    rebalanceIntervalMs: 0,
    rebalanceDailyMaxAttempts: 0,
    heartbeatEnabled: false,
    heartbeatIntervalMs: 3_600_000,
    heartbeatDailyCapBase: 0n,
    heartbeatTradeBase: 0n,
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
  // Alerting OFF (no URLs) — runArbOnce/buildSwapArgs don't touch the alerter; this only
  // satisfies the ArbConfig shape now that it carries an `alert` block.
  alert: { dedupeWindowMs: 900_000, heartbeatIntervalMs: 300_000, timeoutMs: 5_000 },
};

const account = { address: OWNER } as Account;
const chain = { id: 1234 } as Chain;
const BASE_IS_TOKEN0 = false; // cirBTC is token1

// A full slot0 7-tuple with the given sqrtPriceX96 (the rest are inert for the arb path).
const slot0Of = (sqrtPriceX96: bigint) =>
  [sqrtPriceX96, 0, 0, 1, 1, 0, true] as const;

// Pre-computed sqrtPriceX96 for poolPrice18 == REF +/- 1% (baseIsToken0=false), verified to
// round-trip through poolMath and to make decideArb return a SWAP (size capped at maxTradeBase).
const POOL_PRICE_HIGH = REF18 + REF18 / 100n; // +1% -> SELL_BASE
const POOL_PRICE_LOW = REF18 - REF18 / 100n; //  -1% -> BUY_BASE
const SQRT_HIGH = price18ToSqrtPriceX96(POOL_PRICE_HIGH, 8, 6, BASE_IS_TOKEN0);
const SQRT_LOW = price18ToSqrtPriceX96(POOL_PRICE_LOW, 8, 6, BASE_IS_TOKEN0);
const SQRT_REF = price18ToSqrtPriceX96(REF18, 8, 6, BASE_IS_TOKEN0);
// A near-ref pool (+10bps, inside the band) used as the POST-swap re-read so the watchdog
// sees the divergence shrink after a successful swap.
const SQRT_NEAR = price18ToSqrtPriceX96(REF18 + (REF18 * 10n) / 10_000n, 8, 6, BASE_IS_TOKEN0);

// The Pyth integer price for REF18 at expo -8: price18 = price * 10^(18-8) = price * 1e10.
const PYTH_PRICE = REF18 / 10n ** 10n; // 100_000 * 1e8

/**
 * Stub `fetch` so the REAL fetchPythRef parser runs against a canned Hermes response with
 * the given publish_time (so refAgeSec can be made fresh or stale).
 */
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
type WriteReq = { address: string; functionName: string; args?: unknown[]; value?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };

/**
 * Build a single shared public+wallet client pair backed by a programmable on-chain state.
 * `slot0Reads` is a queue: the first slot0 read returns slot0Reads[0] (the pre-trade pool),
 * the second (the POST-swap re-read) returns slot0Reads[1] if present, else repeats the last.
 * `writeContract` is one spy recording EVERY write (approve + exactInputSingle) in order so we
 * can assert approvals precede the swap AND that the arena is never staked.
 */
function makeClients(opts: {
  slot0Reads: readonly (readonly [bigint, number, number, number, number, number, boolean])[];
  liquidity: bigint;
  allowances?: Record<string, bigint>;
  balances?: { base?: bigint; quote?: bigint };
  swapReceiptStatus?: 'success' | 'reverted';
}) {
  const allowances = opts.allowances ?? {};
  const baseBal = opts.balances?.base ?? 10n ** 8n * 1_000n; // 1000 base
  const quoteBal = opts.balances?.quote ?? 10n ** 6n * 100_000_000n; // plenty of USDC
  let slot0Idx = 0;

  const writeCalls: WriteReq[] = [];

  const readContract = vi.fn(async (req: ReadReq) => {
    switch (req.functionName) {
      case 'token0':
        // token0 = USDC (cirBTC sorts higher) => baseIsToken0 = false.
        return QUOTE;
      case 'slot0': {
        const i = Math.min(slot0Idx, opts.slot0Reads.length - 1);
        slot0Idx += 1;
        return opts.slot0Reads[i];
      }
      case 'liquidity':
        return opts.liquidity;
      case 'balanceOf': {
        const token = (req.address as string).toLowerCase();
        if (token === BASE.toLowerCase()) return baseBal;
        if (token === QUOTE.toLowerCase()) return quoteBal;
        return 0n;
      }
      case 'allowance':
        return allowances[(req.address as string).toLowerCase()] ?? 0n;
      default:
        throw new Error(`unexpected read ${req.functionName}`);
    }
  });

  const writeContract = vi.fn(async (req: WriteReq) => {
    writeCalls.push(req);
    if (req.functionName === 'approve') return ('0x' + 'a1'.repeat(32)) as `0x${string}`;
    if (req.functionName === 'exactInputSingle') return ('0x' + 'f1'.repeat(32)) as `0x${string}`;
    throw new Error(`unexpected write ${req.functionName}`);
  });

  const waitForTransactionReceipt = vi.fn(async (req: { hash: `0x${string}` }) => {
    // Approve receipts always succeed; the swap receipt status is configurable.
    const isSwap = req.hash === ('0x' + 'f1'.repeat(32));
    return { status: isSwap ? (opts.swapReceiptStatus ?? 'success') : 'success' };
  });

  const client = { readContract, waitForTransactionReceipt } as unknown as PublicClient;
  const wallet = { writeContract } as unknown as WalletClient;
  return { client, wallet, writeCalls, readContract, writeContract, waitForTransactionReceipt };
}

const FRESH = () => Math.floor(Date.now() / 1000) - 5; // 5s old => well inside maxRefAgeSec

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('arb executor — resolveBaseIsToken0 (startup wiring)', () => {
  it('reads token0 and resolves baseIsToken0=false for the cirBTC/USDC pool', async () => {
    const { client } = makeClients({ slot0Reads: [slot0Of(SQRT_HIGH)], liquidity: 5n * 10n ** 15n });
    const baseIsToken0 = await resolveBaseIsToken0(client, market.pool, market.base);
    expect(baseIsToken0).toBe(false);
  });
});

describe('arb executor — (a) approvals are ensured before swapping', () => {
  it('approves BOTH legs at startup, THEN the first tick swaps (approve writes precede the swap write)', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls } = makeClients({
      slot0Reads: [slot0Of(SQRT_HIGH), slot0Of(SQRT_NEAR)],
      liquidity: 5n * 10n ** 15n,
      allowances: {}, // neither leg approved yet
    });

    // main() runs the preflight approval FIRST, then enters the tick loop.
    await ensureRouterApprovals(client, wallet, account, chain, market, CFG.gasFloorWei, CFG.receiptTimeoutMs, true);
    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);

    expect(rec.kind).toBe('SWAP');
    expect(rec.error).toBeUndefined();

    // Write order: approve(base), approve(quote), THEN exactInputSingle.
    expect(writeCalls.map((w) => w.functionName)).toEqual(['approve', 'approve', 'exactInputSingle']);
    const swapIdx = writeCalls.findIndex((w) => w.functionName === 'exactInputSingle');
    const lastApproveIdx = writeCalls.map((w) => w.functionName).lastIndexOf('approve');
    expect(lastApproveIdx).toBeLessThan(swapIdx); // approvals strictly BEFORE the swap
    expect(writeCalls[0]!.args).toEqual([ROUTER, MAX_UINT256]);
    expect(writeCalls[1]!.args).toEqual([ROUTER, MAX_UINT256]);
  });

  it('SKIPS approvals when allowance is already sufficient, then still swaps', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls, writeContract } = makeClients({
      slot0Reads: [slot0Of(SQRT_HIGH), slot0Of(SQRT_NEAR)],
      liquidity: 5n * 10n ** 15n,
      allowances: { [BASE.toLowerCase()]: MAX_UINT256, [QUOTE.toLowerCase()]: MAX_UINT256 },
    });

    const approvals = await ensureRouterApprovals(client, wallet, account, chain, market, CFG.gasFloorWei, CFG.receiptTimeoutMs, true);
    expect(approvals.every((a) => a.sufficient === true)).toBe(true);
    expect(approvals.every((a) => a.approvedTxHash === undefined)).toBe(true);

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);
    expect(rec.kind).toBe('SWAP');

    // NO approve write ever — only the swap.
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeCalls.map((w) => w.functionName)).toEqual(['exactInputSingle']);
  });
});

describe('arb executor — (b) the decided trade calls exactInputSingle with the expected args', () => {
  it('SELL_BASE: base in, USDC out, amountIn = sized base, sqrtPriceLimit pinned to the ref (sane undershoot)', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls } = makeClients({
      slot0Reads: [slot0Of(SQRT_HIGH), slot0Of(SQRT_NEAR)], // pool +1% above ref
      liquidity: 5n * 10n ** 15n,
      allowances: { [BASE.toLowerCase()]: MAX_UINT256, [QUOTE.toLowerCase()]: MAX_UINT256 },
    });

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);
    expect(rec.kind).toBe('SWAP');
    expect(rec.direction).toBe('SELL_BASE');

    const swap = writeCalls.find((w) => w.functionName === 'exactInputSingle')!;
    expect(swap.address).toBe(ROUTER); // routed at the SwapRouter, never the arena
    const p = (swap.args as any[])[0];
    expect(p.tokenIn).toBe(BASE);
    expect(p.tokenOut).toBe(QUOTE);
    expect(p.fee).toBe(market.feeTier);
    expect(p.recipient).toBe(OWNER);
    // amountIn is the sized base notional (capped at maxTradeBase = 100 base = 1e10 raw).
    expect(p.amountIn).toBe(CFG.params.maxTradeBase);
    // sqrtPriceLimit is PINNED to the ref price (an undershoot bound) — equals the pure builder.
    const expected = buildSwapArgs(
      { kind: 'SWAP', direction: 'SELL_BASE', amountInBase: p.amountIn, reason: '' },
      market, REF18, BASE_IS_TOKEN0, CFG.params.slippageBps,
    );
    expect(p.sqrtPriceLimitX96).toBe(expected.sqrtPriceLimitX96);
    expect(p.sqrtPriceLimitX96).toBe(SQRT_REF);
    expect(p.amountOutMinimum).toBe(expected.amountOutMinimum);
    // SANE undershoot: for baseIsToken0=false a SELL pushes price DOWN (sqrt UP) from the pool
    // toward the ref, so the pinned limit sits strictly between the pool sqrt and the ref.
    expect(SQRT_HIGH < p.sqrtPriceLimitX96).toBe(true); // can fill UP TO the ref…
    expect(p.sqrtPriceLimitX96).toBeLessThan(SQRT_LOW); // …and no further (never overshoots)
    // Gas pinned to the Arc floor + the swap is non-payable here (value never set to non-zero).
    expect(swap.maxFeePerGas).toBe(CFG.gasFloorWei);
    expect(swap.maxPriorityFeePerGas).toBe(CFG.gasFloorWei);
  });

  it('BUY_BASE: USDC in, base out, amountIn = USDC value of the base target at ref', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls } = makeClients({
      slot0Reads: [slot0Of(SQRT_LOW), slot0Of(SQRT_NEAR)], // pool -1% below ref
      liquidity: 5n * 10n ** 15n,
      allowances: { [BASE.toLowerCase()]: MAX_UINT256, [QUOTE.toLowerCase()]: MAX_UINT256 },
    });

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);
    expect(rec.kind).toBe('SWAP');
    expect(rec.direction).toBe('BUY_BASE');

    const swap = writeCalls.find((w) => w.functionName === 'exactInputSingle')!;
    const p = (swap.args as any[])[0];
    expect(p.tokenIn).toBe(QUOTE);
    expect(p.tokenOut).toBe(BASE);
    const expected = buildSwapArgs(
      { kind: 'SWAP', direction: 'BUY_BASE', amountInBase: CFG.params.maxTradeBase, reason: '' },
      market, REF18, BASE_IS_TOKEN0, CFG.params.slippageBps,
    );
    // amountIn is the USDC value (6dp) of the capped base target at the ref price.
    expect(p.amountIn).toBe(expected.amountIn);
    expect(p.amountOutMinimum).toBe(expected.amountOutMinimum);
    expect(p.sqrtPriceLimitX96).toBe(SQRT_REF);
  });

  it('sets a deadline ~30s in the future (no immediate-expiry revert)', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls } = makeClients({
      slot0Reads: [slot0Of(SQRT_HIGH), slot0Of(SQRT_NEAR)],
      liquidity: 5n * 10n ** 15n,
      allowances: { [BASE.toLowerCase()]: MAX_UINT256, [QUOTE.toLowerCase()]: MAX_UINT256 },
    });
    const before = BigInt(Math.floor(Date.now() / 1000));
    await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);
    const p = ((writeCalls.find((w) => w.functionName === 'exactInputSingle')!).args as any[])[0];
    expect(p.deadline).toBeGreaterThanOrEqual(before + 25n);
    expect(p.deadline).toBeLessThanOrEqual(before + 35n);
  });
});

describe('arb executor — (c) post-swap watchdog: success vs reverted', () => {
  it('SUCCESS: re-reads the pool after the receipt and records a (shrunk) postSwapDivBps, no error', async () => {
    stubHermes(FRESH());
    const { client, wallet, readContract } = makeClients({
      slot0Reads: [slot0Of(SQRT_HIGH), slot0Of(SQRT_NEAR)], // pre +100bps, post +10bps
      liquidity: 5n * 10n ** 15n,
      allowances: { [BASE.toLowerCase()]: MAX_UINT256, [QUOTE.toLowerCase()]: MAX_UINT256 },
      swapReceiptStatus: 'success',
    });

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);

    expect(rec.kind).toBe('SWAP');
    expect(rec.error).toBeUndefined();
    expect(rec.txHash).toBeDefined();
    // Pre-trade divergence ~ +100bps; post-swap re-read ~ +10bps => the watchdog sees a shrink.
    expect(rec.divBps).toBe(100);
    expect(rec.postSwapDivBps).toBe(10);
    expect(Math.abs(rec.postSwapDivBps!)).toBeLessThan(Math.abs(rec.divBps!));
    // slot0 was read TWICE (pre-trade + the post-swap re-read).
    const slot0Calls = readContract.mock.calls.filter((c) => (c[0] as ReadReq).functionName === 'slot0');
    expect(slot0Calls.length).toBe(2);
  });

  it('REVERTED swap: rec.error is set, NO postSwapDivBps, pool is NOT re-read', async () => {
    stubHermes(FRESH());
    const { client, wallet, readContract } = makeClients({
      slot0Reads: [slot0Of(SQRT_HIGH)], // only the pre-trade read should occur
      liquidity: 5n * 10n ** 15n,
      allowances: { [BASE.toLowerCase()]: MAX_UINT256, [QUOTE.toLowerCase()]: MAX_UINT256 },
      swapReceiptStatus: 'reverted',
    });

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);

    expect(rec.kind).toBe('SWAP');
    expect(rec.txHash).toBeDefined(); // the swap was broadcast…
    expect(rec.error).toMatch(/swap reverted/i); // …but mined as a revert => FAILURE
    expect(rec.postSwapDivBps).toBeUndefined(); // no attributable measurement
    const slot0Calls = readContract.mock.calls.filter((c) => (c[0] as ReadReq).functionName === 'slot0');
    expect(slot0Calls.length).toBe(1); // no post-swap re-read on a reverted swap
  });

  it('STALE ref => SKIP: no swap is broadcast at all', async () => {
    stubHermes(Math.floor(Date.now() / 1000) - 10_000); // ancient publish_time
    const { client, wallet, writeContract } = makeClients({
      slot0Reads: [slot0Of(SQRT_HIGH)],
      liquidity: 5n * 10n ** 15n,
      allowances: { [BASE.toLowerCase()]: MAX_UINT256, [QUOTE.toLowerCase()]: MAX_UINT256 },
    });

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);
    expect(rec.kind).toBe('SKIP');
    expect(writeContract).not.toHaveBeenCalled();
    expect(rec.txHash).toBeUndefined();
  });

  it('inside the no-trade band => NONE: no swap, no error', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeContract } = makeClients({
      slot0Reads: [slot0Of(SQRT_NEAR)], // only +10bps, inside the 55bps band
      liquidity: 5n * 10n ** 15n,
      allowances: { [BASE.toLowerCase()]: MAX_UINT256, [QUOTE.toLowerCase()]: MAX_UINT256 },
    });

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);
    expect(rec.kind).toBe('NONE');
    expect(rec.error).toBeUndefined();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('captures an RPC error into rec.error instead of throwing out of the tick', async () => {
    stubHermes(FRESH());
    const client = {
      readContract: vi.fn(async () => {
        throw new Error('rpc down');
      }),
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient;
    const wallet = { writeContract: vi.fn() } as unknown as WalletClient;

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);
    expect(rec.error).toMatch(/rpc down/);
    expect((wallet as any).writeContract).not.toHaveBeenCalled();
  });
});

describe('arb executor — (d) NEVER stakes the arena', () => {
  it('every write is approve / exactInputSingle — no stake, and the arena address is never written to', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls } = makeClients({
      slot0Reads: [slot0Of(SQRT_HIGH), slot0Of(SQRT_NEAR)],
      liquidity: 5n * 10n ** 15n,
      allowances: {}, // force the approval writes too
    });

    await ensureRouterApprovals(client, wallet, account, chain, market, CFG.gasFloorWei, CFG.receiptTimeoutMs, true);
    await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);

    const fns = writeCalls.map((w) => w.functionName);
    // The ONLY contract writes the arb bot ever issues.
    for (const fn of fns) expect(['approve', 'exactInputSingle']).toContain(fn);
    expect(fns).not.toContain('stake');
    expect(fns).not.toContain('enter');
    // It never touches the arena contract — every write targets a token or the router.
    for (const w of writeCalls) {
      expect(w.address.toLowerCase()).not.toBe(market.arena.toLowerCase());
      expect([BASE.toLowerCase(), QUOTE.toLowerCase(), ROUTER.toLowerCase()]).toContain(w.address.toLowerCase());
    }
  });
});
