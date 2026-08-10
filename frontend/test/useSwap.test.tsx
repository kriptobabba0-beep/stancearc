import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { maxUint256 } from 'viem';

// useSwap swaps one pool token for the other via SwapRouter.exactInputSingle. Because the router PULLS
// the input token (transferFrom), the flow is up to TWO txs (allowance short-circuit, like
// useStakeWithConviction): approve(router, MAX) AWAITED once, then exactInputSingle. We verify:
//   - approve-then-swap ORDERING (approve simulated+written+awaited before the swap simulate),
//   - the exactInputSingle args: fee = FEE_TIER (3000), recipient = user, sqrtPriceLimitX96 = 0,
//     tokenIn/tokenOut/amountIn/amountOutMinimum, and the Arc 20-gwei gas floor on the write,
//   - the allowance SHORT-CIRCUIT (skip approve when allowance ≥ amountIn → single swap tx),
//   - the toast resolves to success / reverted / timeout off publicClient.waitForTransactionReceipt.

const ROUTER = '0x7fcef1330b4c21f884d6894f3d6a56036e587aa9' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;
const CIRBTC = '0x00000000000000000000000000000000000cir8tc' as const;
const USDC = '0x3600000000000000000000000000000000000000' as const;

vi.mock('@/lib/contracts', () => ({
  swapRouter: { address: '0x7fcef1330b4c21f884d6894f3d6a56036e587aa9' as const, abi: [{ type: 'function', name: 'exactInputSingle' }] },
}));

vi.mock('@/lib/env', () => ({ ENV: { FEE_TIER: 3000 } }));

vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
  MAX_PRIORITY_FEE_WEI: 1_000_000_000n,
  arcTestnet: { id: 5042002 },
  withGasFloor: <T,>(request: T) => ({
    ...request,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }),
}));

vi.mock('@/hooks/usePollInterval', () => ({ bumpPollAfterWrite: vi.fn() }));
vi.mock('@/lib/errors', () => ({ friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock('@/hooks/useTxToast', () => ({ TX_RECEIPT_TIMEOUT_MS: 120_000 }));

// Per-test drivers for the imperative reads/waits.
const allowanceValue = vi.hoisted(() => ({ current: 0n as bigint }));
// Flat driver: `status` is the mined receipt status; `throws` makes the receipt wait reject (timeout).
const receiptResult = vi.hoisted(() => ({
  status: 'success' as 'success' | 'reverted',
  throws: false,
  logs: [] as Array<{ address: string; topics: string[]; data: string }>,
}));

const readContract = vi.fn(async (_cfg: { functionName?: string }) => allowanceValue.current);
const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
const writeContractAsync = vi.fn(async (_cfg: Record<string, unknown>) => '0xhash' as `0x${string}`);
const waitForTransactionReceipt = vi.fn(async (_cfg: unknown) => {
  if (receiptResult.throws) throw new Error('timeout');
  return { status: receiptResult.status, logs: receiptResult.logs };
});

vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  usePublicClient: () => ({ readContract, simulateContract, waitForTransactionReceipt }),
  useWriteContract: () => ({ writeContractAsync, data: undefined, isPending: false }),
}));

const refetchQueries = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ refetchQueries }) }));
const toastMock = vi.hoisted(() => ({ loading: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock, arcScanTxUrl: () => undefined }));

import { useSwap } from '@/hooks/useSwap';

beforeEach(() => {
  readContract.mockClear();
  simulateContract.mockClear();
  writeContractAsync.mockClear();
  waitForTransactionReceipt.mockClear();
  refetchQueries.mockClear();
  toastMock.loading.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  allowanceValue.current = 0n;
  receiptResult.status = 'success';
  receiptResult.throws = false;
  receiptResult.logs = [];
});
afterEach(cleanup);

describe('useSwap().swap — approve-then-swap', () => {
  it('approves the router (MAX, once) then exactInputSingle when allowance is insufficient', async () => {
    allowanceValue.current = 0n; // must approve first
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: CIRBTC, tokenOut: USDC, amountIn: 100_000000n, amountOutMinimum: 990_000000n });
    });

    // Two simulate + two writes: approve, then exactInputSingle.
    expect(simulateContract).toHaveBeenCalledTimes(2);
    const approveCfg = simulateContract.mock.calls[0][0] as { functionName: string; args: unknown[]; address: string };
    expect(approveCfg.functionName).toBe('approve');
    expect(approveCfg.address).toBe(CIRBTC);
    // MAX approval so the user is approved for ALL future swaps after the first (not re-prompted).
    expect(approveCfg.args).toEqual([ROUTER, maxUint256]);

    const swapCfg = simulateContract.mock.calls[1][0] as { functionName: string; args: { tokenIn: string; tokenOut: string; fee: number; recipient: string; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }[]; address: string; account: string };
    expect(swapCfg.functionName).toBe('exactInputSingle');
    expect(swapCfg.address).toBe(ROUTER);
    expect(swapCfg.account).toBe(USER);
    const p = swapCfg.args[0];
    expect(p.tokenIn).toBe(CIRBTC);
    expect(p.tokenOut).toBe(USDC);
    expect(p.fee).toBe(3000); // FEE_TIER
    expect(p.recipient).toBe(USER);
    expect(p.amountIn).toBe(100_000000n);
    expect(p.amountOutMinimum).toBe(990_000000n);
    expect(p.sqrtPriceLimitX96).toBe(0n);

    // Both writes carry the Arc gas floor.
    expect(writeContractAsync).toHaveBeenCalledTimes(2);
    for (const call of writeContractAsync.mock.calls) {
      const wcfg = call[0] as Record<string, unknown>;
      expect(wcfg.maxFeePerGas).toBe(20_000_000_000n);
      expect(wcfg.maxPriorityFeePerGas).toBe(1_000_000_000n);
    }
  });

  it('AWAITS the approve receipt BEFORE simulating the swap', async () => {
    allowanceValue.current = 0n;
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: CIRBTC, tokenOut: USDC, amountIn: 100_000000n, amountOutMinimum: 0n });
    });

    // Order: approve simulate (1st) → approve write (1st) → approve receipt wait (1st) → swap simulate (2nd) → swap write (2nd).
    const approveSimulate = simulateContract.mock.invocationCallOrder[0];
    const approveWrite = writeContractAsync.mock.invocationCallOrder[0];
    const approveWait = waitForTransactionReceipt.mock.invocationCallOrder[0];
    const swapSimulate = simulateContract.mock.invocationCallOrder[1];
    const swapWrite = writeContractAsync.mock.invocationCallOrder[1];
    expect(approveSimulate).toBeLessThan(approveWrite);
    expect(approveWrite).toBeLessThan(approveWait);
    expect(approveWait).toBeLessThan(swapSimulate);
    expect(swapSimulate).toBeLessThan(swapWrite);
    // The swap receipt is the SECOND wait.
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);
  });
});

describe('useSwap().swap — allowance short-circuit', () => {
  it('skips the approve when allowance already covers amountIn (single swap tx)', async () => {
    allowanceValue.current = 1_000_000000n; // covers amountIn
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 500_000000n, amountOutMinimum: 0n });
    });
    expect(simulateContract).toHaveBeenCalledTimes(1);
    const onlyCfg = simulateContract.mock.calls[0][0] as { functionName: string };
    expect(onlyCfg.functionName).toBe('exactInputSingle');
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    // Only the swap receipt is awaited (no approve wait).
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-positive amountIn (no read/simulate/write)', async () => {
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await expect(result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 0n, amountOutMinimum: 0n })).rejects.toThrow();
    });
    expect(readContract).not.toHaveBeenCalled();
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContractAsync).not.toHaveBeenCalled();
  });
});

describe('useSwap().swap — receipt toast resolution', () => {
  it('toasts success and refetches on a mined receipt', async () => {
    allowanceValue.current = 1_000_000000n;
    receiptResult.status = 'success';
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 10_000000n, amountOutMinimum: 0n });
    });
    expect(toastMock.success).toHaveBeenCalledWith('Swapped', { id: 'swap' });
    expect(result.current.isSuccess).toBe(true);
    expect(refetchQueries).toHaveBeenCalledWith({ type: 'active' });
  });

  it('toasts a revert (not success) on a mined-but-reverted receipt', async () => {
    allowanceValue.current = 1_000_000000n;
    receiptResult.status = 'reverted';
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 10_000000n, amountOutMinimum: 0n });
    });
    expect(toastMock.error).toHaveBeenCalledWith('Swap reverted', { id: 'swap' });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(result.current.isSuccess).toBe(false);
  });

  it('toasts a non-stuck timeout message when the receipt wait throws', async () => {
    allowanceValue.current = 1_000_000000n;
    receiptResult.throws = true; // waitForTransactionReceipt rejects (timeout / RPC stall)
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 10_000000n, amountOutMinimum: 0n });
    });
    // Error toast (reassuring, non-stuck) but NOT a failure throw — the swap was submitted.
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect((toastMock.error.mock.calls[0][0] as string)).toMatch(/couldn’t confirm yet|update shortly/i);
    expect(toastMock.success).not.toHaveBeenCalled();
    // Still refetches so balances surface once the (likely-confirmed) swap lands.
    expect(refetchQueries).toHaveBeenCalledWith({ type: 'active' });
  });
});

// The confirmation screen puts a number in front of the user next to a link to the transaction,
// so the number has to come from that transaction. These cover the wiring from receipt to result.
describe('useSwap().swap — the settled result', () => {
  const ME = '0x1111111111111111111111111111111111111111';
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
  const hex = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;

  it('reports the amount that actually landed, read off the receipt', async () => {
    allowanceValue.current = 1_000_000000n;
    receiptResult.logs = [
      { address: USDC, topics: [TRANSFER, pad(ME), pad('0x9999999999999999999999999999999999999999')], data: hex(10_000000n) },
      { address: CIRBTC, topics: [TRANSFER, pad('0x9999999999999999999999999999999999999999'), pad(ME)], data: hex(1_206n) },
    ];
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 10_000000n, amountOutMinimum: 0n });
    });
    expect(result.current.result?.amountOut).toBe(1_206n);
    expect(result.current.result?.amountIn).toBe(10_000000n);
    expect(result.current.result?.tokenOut).toBe(CIRBTC);
  });

  it('still reports the swap when the receipt carried no readable payout', async () => {
    // Confirmed is confirmed. The screen then shows the trade without inventing an amount.
    allowanceValue.current = 1_000_000000n;
    receiptResult.logs = [];
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 10_000000n, amountOutMinimum: 0n });
    });
    expect(result.current.result).toBeTruthy();
    expect(result.current.result?.amountOut).toBeNull();
  });

  it('leaves no result behind for a reverted swap', async () => {
    allowanceValue.current = 1_000_000000n;
    receiptResult.status = 'reverted';
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 10_000000n, amountOutMinimum: 0n });
    });
    expect(result.current.result).toBeUndefined();
  });

  it('leaves no result behind when the receipt never arrived', async () => {
    // The swap may well have confirmed, but we cannot say so — a receipt we never read is not
    // grounds for a "completed" screen.
    allowanceValue.current = 1_000_000000n;
    receiptResult.throws = true;
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 10_000000n, amountOutMinimum: 0n });
    });
    expect(result.current.result).toBeUndefined();
  });

  it('reset() clears the confirmation so the next trade starts clean', async () => {
    allowanceValue.current = 1_000_000000n;
    receiptResult.logs = [
      { address: CIRBTC, topics: [TRANSFER, pad('0x9999999999999999999999999999999999999999'), pad(ME)], data: hex(7n) },
    ];
    const { result } = renderHook(() => useSwap());
    await act(async () => {
      await result.current.swap({ tokenIn: USDC, tokenOut: CIRBTC, amountIn: 10_000000n, amountOutMinimum: 0n });
    });
    expect(result.current.result).toBeTruthy();
    act(() => result.current.reset());
    expect(result.current.result).toBeUndefined();
    expect(result.current.isSuccess).toBe(false);
  });
});
