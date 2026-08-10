import { describe, it, expect, vi } from 'vitest';
import { ensureRouterApprovals } from '../src/arb.js';
import type { ArbConfig } from '../src/config.js';
import type { Account, Chain, PublicClient, WalletClient } from 'viem';

// MEDIUM fix coverage — the router allowance preflight. Without a prior ERC20 approve,
// every exactInputSingle reverts with STF and the bot wedges opaquely. ensureRouterApprovals
// checks allowance(owner, router) for BOTH legs (base + quote) and auto-approves once (or,
// with autoApprove=false, throws an actionable error). These tests use lightweight viem
// client/wallet stubs (no chain) — the on-chain executor itself is integration-tested.

const OWNER = '0x000000000000000000000000000000000000000a' as `0x${string}`;
const ROUTER = '0x7fcEF1330B4C21f884D6894f3d6a56036E587aA9' as `0x${string}`;
const BASE = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' as `0x${string}`;
const QUOTE = '0x3600000000000000000000000000000000000000' as `0x${string}`;

const MAX_UINT256 = (1n << 256n) - 1n;

const market: ArbConfig['market'] = {
  id: 'cirbtc',
  label: 'cirBTC / USDC',
  arena: '0x000000000000000000000000000000000000dEaD',
  pool: '0x0000000000000000000000000000000000000001',
  base: BASE,
  baseDecimals: 8,
  quote: QUOTE,
  quoteDecimals: 6,
  feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  router: ROUTER,
  feeTier: 3000,
};

const account = { address: OWNER } as Account;
const chain = { id: 1234 } as Chain;
const GAS_FLOOR = 20_000_000_000n;
const RECEIPT_TIMEOUT = 90_000;

/**
 * Build a stubbed public+wallet client pair. `allowances` maps token address -> the
 * allowance the stubbed `allowance()` read returns. `receiptStatus` controls the mocked
 * approval receipt. The writeContract spy records every approve call so we can assert the
 * exact (token, spender, amount) tuples.
 */
function makeClients(opts: {
  allowances: Record<string, bigint>;
  receiptStatus?: 'success' | 'reverted';
}) {
  const writeCalls: Array<{ address: string; functionName: string; args: unknown[] }> = [];
  const readContract = vi.fn(async (req: any) => {
    if (req.functionName === 'allowance') {
      const token = (req.address as string).toLowerCase();
      return opts.allowances[token] ?? 0n;
    }
    throw new Error(`unexpected read ${req.functionName}`);
  });
  const writeContract = vi.fn(async (req: any) => {
    writeCalls.push({ address: req.address, functionName: req.functionName, args: req.args });
    return ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  });
  const waitForTransactionReceipt = vi.fn(async () => ({
    status: opts.receiptStatus ?? 'success',
  }));

  const client = { readContract, waitForTransactionReceipt } as unknown as PublicClient;
  const wallet = { writeContract } as unknown as WalletClient;
  return { client, wallet, writeCalls, readContract, writeContract, waitForTransactionReceipt };
}

describe('ensureRouterApprovals — preflight', () => {
  it('approves BOTH legs when neither is approved (allowance 0)', async () => {
    const { client, wallet, writeCalls, writeContract, waitForTransactionReceipt } = makeClients({
      allowances: {}, // both 0
    });
    const results = await ensureRouterApprovals(
      client, wallet, account, chain, market, GAS_FLOOR, RECEIPT_TIMEOUT, true,
    );

    // One approve per leg, each to the router for MAX_UINT256.
    expect(writeContract).toHaveBeenCalledTimes(2);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(writeCalls).toEqual([
      { address: BASE, functionName: 'approve', args: [ROUTER, MAX_UINT256] },
      { address: QUOTE, functionName: 'approve', args: [ROUTER, MAX_UINT256] },
    ]);
    expect(results.map((r) => r.leg)).toEqual(['base', 'quote']);
    expect(results.every((r) => r.sufficient === false)).toBe(true);
    expect(results.every((r) => r.approvedTxHash !== undefined)).toBe(true);
  });

  it('is a NO-OP when both legs are already approved at/above the threshold', async () => {
    const { client, wallet, writeContract } = makeClients({
      allowances: {
        [BASE.toLowerCase()]: MAX_UINT256,
        [QUOTE.toLowerCase()]: MAX_UINT256,
      },
    });
    const results = await ensureRouterApprovals(
      client, wallet, account, chain, market, GAS_FLOOR, RECEIPT_TIMEOUT, true,
    );
    expect(writeContract).not.toHaveBeenCalled(); // no re-approval
    expect(results.every((r) => r.sufficient === true)).toBe(true);
    expect(results.every((r) => r.approvedTxHash === undefined)).toBe(true);
  });

  it('approves ONLY the short leg (base approved, quote not)', async () => {
    const { client, wallet, writeCalls } = makeClients({
      allowances: { [BASE.toLowerCase()]: MAX_UINT256 }, // base ok, quote 0
    });
    const results = await ensureRouterApprovals(
      client, wallet, account, chain, market, GAS_FLOOR, RECEIPT_TIMEOUT, true,
    );
    // Only the quote leg gets an approve tx.
    expect(writeCalls).toEqual([
      { address: QUOTE, functionName: 'approve', args: [ROUTER, MAX_UINT256] },
    ]);
    expect(results.find((r) => r.leg === 'base')!.approvedTxHash).toBeUndefined();
    expect(results.find((r) => r.leg === 'quote')!.approvedTxHash).toBeDefined();
  });

  it('re-approves a leg whose allowance is below the half-max threshold', async () => {
    // A small leftover allowance (e.g. 1000 USDC raw) is below threshold -> re-approve.
    const { client, wallet, writeContract } = makeClients({
      allowances: {
        [BASE.toLowerCase()]: MAX_UINT256,
        [QUOTE.toLowerCase()]: 1_000n,
      },
    });
    await ensureRouterApprovals(
      client, wallet, account, chain, market, GAS_FLOOR, RECEIPT_TIMEOUT, true,
    );
    expect(writeContract).toHaveBeenCalledTimes(1); // only quote
  });

  it('FAILS FAST with an actionable error when autoApprove is false and a leg is short', async () => {
    const { client, wallet, writeContract } = makeClients({ allowances: {} });
    await expect(
      ensureRouterApprovals(client, wallet, account, chain, market, GAS_FLOOR, RECEIPT_TIMEOUT, false),
    ).rejects.toThrow(/approve the router/i);
    expect(writeContract).not.toHaveBeenCalled(); // never sends a tx in fail-fast mode
  });

  it('throws if an approval tx reverts (so the bot does not start half-approved)', async () => {
    const { client, wallet } = makeClients({ allowances: {}, receiptStatus: 'reverted' });
    await expect(
      ensureRouterApprovals(client, wallet, account, chain, market, GAS_FLOOR, RECEIPT_TIMEOUT, true),
    ).rejects.toThrow(/reverted/i);
  });

  it('pins the Arc gas floor on every approval write', async () => {
    const writes: any[] = [];
    const client = {
      readContract: vi.fn(async () => 0n),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    } as unknown as PublicClient;
    const wallet = {
      writeContract: vi.fn(async (req: any) => {
        writes.push(req);
        return ('0x' + 'cd'.repeat(32)) as `0x${string}`;
      }),
    } as unknown as WalletClient;
    await ensureRouterApprovals(client, wallet, account, chain, market, GAS_FLOOR, RECEIPT_TIMEOUT, true);
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.maxFeePerGas).toBe(GAS_FLOOR);
      expect(w.maxPriorityFeePerGas).toBe(GAS_FLOOR);
    }
  });
});
