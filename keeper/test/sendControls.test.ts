import { describe, it, expect, vi } from 'vitest';
import { toFunctionSelector } from 'viem';
import { sendWriteWithEscalation, WouldRevertError, type SendControls } from '../src/keeper.js';
import { SpendCapTrippedError, type SpendGuard } from '../src/spendGuard.js';
import { freshLedger } from '../src/spendBreaker.js';
import type { KeeperConfig } from '../src/config.js';

// Minimal cfg slice the send path reads: gas escalation (OFF — single floor send) + receipt timeout.
const CFG = {
  gasEscalation: { floorWei: 28_000_000_000n, capWei: 140_000_000_000n, multiplierBps: 12_500, maxAttempts: 0 },
  receiptTimeoutMs: 90_000,
} as unknown as KeeperConfig;

const base = {
  address: '0x000000000000000000000000000000000000bEEF' as `0x${string}`,
  abi: [] as never,
  account: { address: '0x000000000000000000000000000000000000dEaD' } as never,
  chain: { id: 5042002 } as never,
};
const fields = { functionName: 'submitSettlementPrice', args: [1n], value: 5n };
const ctx = { market: 'cirbtc', action: 'SETTLE' };

/** A thrown error carrying a known custom-error selector in `.data` — what classifyRevert reads. */
function revertError(name: string): Error {
  return Object.assign(new Error(`execution reverted`), { data: toFunctionSelector(`${name}()`) });
}

function okClient(receipt: Record<string, unknown>) {
  return {
    simulateContract: vi.fn(async () => ({ request: { gas: 120_000n } })),
    waitForTransactionReceipt: vi.fn(async () => receipt),
  };
}
const wallet = (hash = '0xabc' as `0x${string}`) => ({ writeContract: vi.fn(async () => hash) });

describe('sendWriteWithEscalation — pre-flight simulate gate', () => {
  it('a doomed crank (sim reverts) throws WouldRevertError and NEVER broadcasts (zero gas)', async () => {
    const client = {
      simulateContract: vi.fn(async () => {
        throw revertError('StalePrice');
      }),
      waitForTransactionReceipt: vi.fn(),
    };
    const w = wallet();
    const send: SendControls = { simulate: true, fallbackGasLimit: 1_500_000n };

    await expect(
      sendWriteWithEscalation(client as never, w as never, base, fields, CFG, ctx, undefined, send),
    ).rejects.toBeInstanceOf(WouldRevertError);
    // The crank was caught BEFORE broadcast — the whole point of the fix.
    expect(w.writeContract).not.toHaveBeenCalled();
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('classifies the revert so StalePrice gets its own backoff signal', async () => {
    const client = {
      simulateContract: vi.fn(async () => {
        throw revertError('StalePrice');
      }),
      waitForTransactionReceipt: vi.fn(),
    };
    const send: SendControls = { simulate: true, fallbackGasLimit: 1_500_000n };
    const err = await sendWriteWithEscalation(client as never, wallet() as never, base, fields, CFG, ctx, undefined, send).catch((e) => e);
    expect(err).toBeInstanceOf(WouldRevertError);
    expect((err as WouldRevertError).info.name).toBe('StalePrice');
    expect((err as WouldRevertError).info.isStale).toBe(true);
  });

  it('a non-revert sim error (RPC blip) does NOT block — it broadcasts anyway (best-effort gate)', async () => {
    const client = {
      simulateContract: vi.fn(async () => {
        throw new Error('connection refused'); // not a revert
      }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', gasUsed: 50_000n, effectiveGasPrice: 28_000_000_000n })),
    };
    const w = wallet();
    const send: SendControls = { simulate: true, fallbackGasLimit: 1_500_000n };
    const r = await sendWriteWithEscalation(client as never, w as never, base, fields, CFG, ctx, undefined, send);
    expect(w.writeContract).toHaveBeenCalledOnce();
    expect(r.receipt.status).toBe('success');
  });

  it('books the ACTUAL gas spent (gasUsed * effectiveGasPrice) on a mined tx', async () => {
    const client = okClient({ status: 'success', gasUsed: 50_000n, effectiveGasPrice: 30_000_000_000n });
    const send: SendControls = { simulate: true, fallbackGasLimit: 1_500_000n };
    const r = await sendWriteWithEscalation(client as never, wallet() as never, base, fields, CFG, ctx, undefined, send);
    expect(r.gasSpentWei).toBe(50_000n * 30_000_000_000n);
  });
});

describe('sendWriteWithEscalation — spend cap gate', () => {
  function guardStub(over: Partial<SpendGuard> = {}): SpendGuard & { booked: bigint[] } {
    const booked: bigint[] = [];
    return {
      enabled: true,
      status: () => ({ tripped: false, reason: null }),
      book: (_now: number, wei: bigint) => {
        booked.push(wei);
        return { tripped: false, reason: null };
      },
      snapshot: () => freshLedger(),
      booked,
      ...over,
    } as SpendGuard & { booked: bigint[] };
  }

  it('a tripped cap throws SpendCapTrippedError and NEVER broadcasts', async () => {
    const client = okClient({ status: 'success', gasUsed: 1n, effectiveGasPrice: 1n });
    const w = wallet();
    const guard = guardStub({ status: () => ({ tripped: true, reason: 'hour-cap' }) });
    const send: SendControls = { simulate: false, guard, fallbackGasLimit: 1_500_000n };
    await expect(
      sendWriteWithEscalation(client as never, w as never, base, fields, CFG, ctx, undefined, send),
    ).rejects.toBeInstanceOf(SpendCapTrippedError);
    expect(w.writeContract).not.toHaveBeenCalled();
  });

  it('books the spend into the guard after a successful broadcast', async () => {
    const client = okClient({ status: 'success', gasUsed: 21_000n, effectiveGasPrice: 28_000_000_000n });
    const guard = guardStub();
    const send: SendControls = { simulate: false, guard, fallbackGasLimit: 1_500_000n };
    await sendWriteWithEscalation(client as never, wallet() as never, base, fields, CFG, ctx, undefined, send);
    expect(guard.booked).toEqual([21_000n * 28_000_000_000n]);
  });

  it('with no controls at all, behavior is unchanged (broadcasts, returns receipt)', async () => {
    const client = okClient({ status: 'success', gasUsed: 21_000n, effectiveGasPrice: 28_000_000_000n });
    const w = wallet();
    const r = await sendWriteWithEscalation(client as never, w as never, base, fields, CFG, ctx);
    expect(w.writeContract).toHaveBeenCalledOnce();
    expect(client.simulateContract).not.toHaveBeenCalled(); // no sim when send is omitted
    expect(r.txHash).toBe('0xabc');
  });
});
