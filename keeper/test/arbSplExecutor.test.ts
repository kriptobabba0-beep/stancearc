import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WaitForTransactionReceiptTimeoutError } from 'viem';
import { runArbOnce } from '../src/arb.js';
import { price18ToSqrtPriceX96 } from '../src/poolMath.js';
import { snapshotHeartbeat, freshHeartbeatLedger } from '../src/heartbeat.js';
import type { ArbConfig } from '../src/config.js';
import type { Account, Chain, PublicClient, WalletClient } from 'viem';

// ---------------------------------------------------------------------------
// FINDING 5 — a REVERT-AWARE executor test layer. The existing arbExecutor tests stub
// waitForTransactionReceipt to ALWAYS succeed, so the SPL bug (a limit not strictly past the
// current pool price) could silently "pass". Here the mock SwapRouter ENFORCES the vendored
// Uniswap-V3 `SPL` require:
//   zeroForOne  (tokenIn == token0)  -> limit < slot0.sqrtPriceX96
//   !zeroForOne (tokenIn == token1)  -> limit > slot0.sqrtPriceX96
// A swap whose sqrtPriceLimitX96 is NOT strictly past the supplied current pool sqrt throws
// `SPL` at writeContract time (matching a chain revert). With the OLD ref-pinned limit a
// rebalance/heartbeat at pool==ref would throw SPL; with the FINDING 1 fix they succeed.
//
// FINDING 2 — also covers the arb receipt-wait-TIMEOUT path: the onSent callback must surface
// the broadcast hash into rec.txHash even when waitForTransactionReceipt times out.
// ---------------------------------------------------------------------------

const ONE18 = 10n ** 18n;
const REF18 = 100_000n * ONE18; // 100,000 USDC per cirBTC, 18dp

const OWNER = '0x000000000000000000000000000000000000000a' as `0x${string}`;
const ROUTER = '0x7fcEF1330B4C21f884D6894f3d6a56036E587aA9' as `0x${string}`;
const BASE = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' as `0x${string}`; // cirBTC (token1)
const QUOTE = '0x3600000000000000000000000000000000000000' as `0x${string}`; // USDC (token0)
const POOL = '0x0000000000000000000000000000000000000005' as `0x${string}`;
const MAX_UINT256 = (1n << 256n) - 1n;
const BASE_IS_TOKEN0 = false;

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
    maxTradeBase: 10n ** 8n * 100n,
    minTradeBase: 1_000n,
    reserveBase: 0n,
    reserveQuote: 0n,
    maxRefAgeSec: 60,
    slippageBps: 75,
    rebalanceFloorBps: 1500,
    rebalanceTargetBps: 5_000,
    rebalanceMaxBase: 10n ** 8n * 100n,
    rebalanceIntervalMs: 0,
    rebalanceDailyMaxAttempts: 0,
    heartbeatEnabled: true,
    heartbeatIntervalMs: 60_000,
    heartbeatDailyCapBase: 10n ** 8n,
    heartbeatTradeBase: 10n ** 6n,
    heartbeatDailyMaxAttempts: 0,
  },
  pollIntervalMs: 15_000,
  gasFloorWei: 20_000_000_000n,
  hermesTimeoutMs: 8_000,
  receiptTimeoutMs: 90_000,
  lowBalanceWei: 500_000_000_000_000_000n,
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
const PYTH_PRICE = REF18 / 10n ** 10n; // expo -8

function stubHermes(publishTimeSec: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        binary: { data: ['00'] },
        parsed: [{ id: market.feedId.slice(2), price: { price: PYTH_PRICE.toString(), conf: '1', expo: -8, publish_time: publishTimeSec } }],
      }),
    })),
  );
}

type ReadReq = { address: string; functionName: string; args?: unknown[] };
type WriteReq = { address: string; functionName: string; args?: unknown[] };

/**
 * An SPL-enforcing mock. The current pool sqrt is `slot0Sqrt`; the mock SwapRouter throws
 * `SPL` if a swap's sqrtPriceLimitX96 is not STRICTLY past that current sqrt in the swap
 * direction — exactly the vendored UniswapV3Pool require. token0=USDC, token1=cirBTC.
 */
function makeSplClients(opts: {
  slot0Sqrt: bigint;
  liquidity: bigint;
  balances?: { base?: bigint; quote?: bigint };
  receiptTimeout?: boolean; // reject waitForTransactionReceipt with a timeout error
}) {
  const baseBal = opts.balances?.base ?? 10n ** 8n * 1_000n;
  const quoteBal = opts.balances?.quote ?? 10n ** 6n * 100_000_000n;
  const writeCalls: WriteReq[] = [];

  const readContract = vi.fn(async (req: ReadReq) => {
    switch (req.functionName) {
      case 'token0':
        return QUOTE; // token0 = USDC => baseIsToken0 = false
      case 'slot0':
        return slot0Of(opts.slot0Sqrt);
      case 'liquidity':
        return opts.liquidity;
      case 'balanceOf': {
        const token = (req.address as string).toLowerCase();
        if (token === BASE.toLowerCase()) return baseBal;
        if (token === QUOTE.toLowerCase()) return quoteBal;
        return 0n;
      }
      case 'allowance':
        return MAX_UINT256;
      default:
        throw new Error(`unexpected read ${req.functionName}`);
    }
  });

  const writeContract = vi.fn(async (req: WriteReq) => {
    writeCalls.push(req);
    if (req.functionName === 'approve') return ('0x' + 'a1'.repeat(32)) as `0x${string}`;
    if (req.functionName === 'exactInputSingle') {
      const p = (req.args as any[])[0];
      const tokenIn = (p.tokenIn as string).toLowerCase();
      // zeroForOne when tokenIn is token0 (=USDC here).
      const zeroForOne = tokenIn === QUOTE.toLowerCase();
      const limit = p.sqrtPriceLimitX96 as bigint;
      const ok = zeroForOne ? limit < opts.slot0Sqrt : limit > opts.slot0Sqrt;
      if (!ok) {
        // Mirror the on-chain `revert SPL` so a wrong-side / equal limit can't silently pass.
        throw new Error('execution reverted: SPL');
      }
      return ('0x' + 'f1'.repeat(32)) as `0x${string}`;
    }
    throw new Error(`unexpected write ${req.functionName}`);
  });

  const waitForTransactionReceipt = vi.fn(async () => {
    if (opts.receiptTimeout) {
      throw new WaitForTransactionReceiptTimeoutError({ hash: ('0x' + 'f1'.repeat(32)) as `0x${string}` });
    }
    return { status: 'success' as const };
  });

  const client = { readContract, waitForTransactionReceipt } as unknown as PublicClient;
  const wallet = { writeContract } as unknown as WalletClient;
  return { client, wallet, writeCalls, writeContract };
}

const FRESH = () => Math.floor(Date.now() / 1000) - 5;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('arb executor — FINDING 5: SPL-enforcing mock proves the limit is strictly past current', () => {
  const SQRT_REF = price18ToSqrtPriceX96(REF18, 8, 6, BASE_IS_TOKEN0);

  it('HEARTBEAT at pool==ref does NOT revert SPL (the fixed limit is strictly past current)', async () => {
    stubHermes(FRESH());
    const { client, wallet, writeCalls } = makeSplClients({ slot0Sqrt: SQRT_REF, liquidity: 5n * 10n ** 15n });
    const snap = snapshotHeartbeat(freshHeartbeatLedger(Date.now()), Date.now());
    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0, snap);

    expect(rec.kind).toBe('SWAP');
    expect(rec.purpose).toBe('heartbeat');
    expect(rec.error).toBeUndefined(); // would be `SPL` revert under the old ref-pinned limit
    expect(writeCalls.some((w) => w.functionName === 'exactInputSingle')).toBe(true);
  });

  it('REBALANCE at pool==ref (base depleted) does NOT revert SPL', async () => {
    stubHermes(FRESH());
    // Base depleted -> BUY_BASE rebalance (tokenIn=USDC=token0 => zeroForOne => limit BELOW current).
    const { client, wallet } = makeSplClients({
      slot0Sqrt: SQRT_REF,
      liquidity: 5n * 10n ** 15n,
      balances: { base: 10n ** 8n, quote: 9_000_000n * 10n ** 6n },
    });
    const snap = snapshotHeartbeat(freshHeartbeatLedger(Date.now()), Date.now());
    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0, snap);

    expect(rec.kind).toBe('SWAP');
    expect(rec.purpose).toBe('rebalance');
    expect(rec.direction).toBe('BUY_BASE');
    expect(rec.error).toBeUndefined();
  });

  it('a real ARB (pool +1% above ref) does NOT revert SPL (ref pin is strictly past current)', async () => {
    stubHermes(FRESH());
    const poolHigh = REF18 + REF18 / 100n;
    const { client, wallet } = makeSplClients({
      slot0Sqrt: price18ToSqrtPriceX96(poolHigh, 8, 6, BASE_IS_TOKEN0),
      liquidity: 5n * 10n ** 15n,
    });
    // No heartbeat snapshot -> a pure arb (purpose 'arb').
    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);
    expect(rec.kind).toBe('SWAP');
    expect(rec.purpose).toBe('arb');
    expect(rec.direction).toBe('SELL_BASE');
    expect(rec.error).toBeUndefined();
  });

  it('GUARD: the SPL mock DOES reject a deliberately wrong-side (equal-to-current) limit', async () => {
    // Sanity-check the test layer itself: a swap whose limit EQUALS current must be rejected,
    // so a future regression that pins the in-band limit back to current can't slip through.
    const { writeContract } = makeSplClients({ slot0Sqrt: SQRT_REF, liquidity: 5n * 10n ** 15n });
    await expect(
      writeContract({
        address: ROUTER,
        functionName: 'exactInputSingle',
        // tokenIn=USDC => zeroForOne => needs limit < current; passing == current must throw SPL.
        args: [{ tokenIn: QUOTE, sqrtPriceLimitX96: SQRT_REF }],
      } as WriteReq),
    ).rejects.toThrow(/SPL/);
  });
});

describe('arb executor — FINDING 2: receipt-wait timeout surfaces rec.txHash via onSent', () => {
  it('a waitForTransactionReceipt TIMEOUT still sets rec.txHash (broadcast hash) + rec.error', async () => {
    stubHermes(FRESH());
    const poolHigh = REF18 + REF18 / 100n;
    const { client, wallet, writeContract } = makeSplClients({
      slot0Sqrt: price18ToSqrtPriceX96(poolHigh, 8, 6, BASE_IS_TOKEN0),
      liquidity: 5n * 10n ** 15n,
      receiptTimeout: true,
    });

    const rec = await runArbOnce(client, wallet, account, chain, CFG, BASE_IS_TOKEN0);

    expect(rec.kind).toBe('SWAP');
    // The swap WAS broadcast (writeContract returned a hash) before the receipt wait timed out.
    expect(writeContract).toHaveBeenCalled();
    expect(rec.txHash).toBe('0x' + 'f1'.repeat(32)); // surfaced via onSent despite the timeout
    expect(rec.error).toMatch(/receipt wait timed out/i);
    expect(rec.error).toContain(rec.txHash!); // the pending hash is named in the error
  });
});
