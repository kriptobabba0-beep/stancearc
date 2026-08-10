import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// useWithdrawCredited surfaces the connected wallet's deferred owed* balances (v2 blocklist-resilient
// payouts) and calls FeeArenaV2.withdrawCredited(to). We verify it reads owedUSDC/owedWETH, derives
// hasCredit, simulates withdrawCredited(to) (default to = connected wallet) with the gas floor, and
// waits on the receipt IMPERATIVELY (publicClient.waitForTransactionReceipt) inside the async fn — NOT
// via the reactive useTxToast/useTxReceipt hooks. That's the fix for the unmount-orphan bug: a
// successful withdraw zeroes the owed* ledger so DeferredPayoutBanner (returns null when !hasCredit)
// UNMOUNTS before the receipt resolves — a reactive receipt-toast would never fire and the sonner
// loading spinner would hang forever. An in-flight async fn keeps running post-unmount, so the toast
// always settles to success/reverted/timeout.

const FEE_ARENA = '0x00000000000000000000000000000000feearena' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;

vi.mock('@/lib/contracts', () => ({
  useMarketContracts: () => ({
    feeArena: { address: FEE_ARENA, abi: [] },
  }),
}));
vi.mock('@/components/MarketProvider', () => ({ useActiveMarket: () => ({ id: 'v2' }) }));
vi.mock('@/lib/markets', () => ({ isV2Market: () => true, isV3Market: () => false }));

vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  arcTestnet: { id: 7777 },
  GAS_FLOOR_WEI: 20_000_000_000n,
  MAX_PRIORITY_FEE_WEI: 1_000_000_000n,
  withGasFloor: <T,>(request: T) => ({
    ...request,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }),
}));

vi.mock('@/hooks/usePollInterval', () => ({ bumpPollAfterWrite: vi.fn(), usePollInterval: () => 5000 }));
vi.mock('@/lib/errors', () => ({ friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
// Spies shared into the hoisted vi.mock factory must be created via vi.hoisted (the factory runs before
// top-level const initialization). We record the toast loading/success/error calls so we can assert the
// toast is RESOLVED imperatively, proving it no longer relies on the unmount-fragile reactive useTxToast.
const { toastLoading, toastSuccess, toastError } = vi.hoisted(() => ({
  toastLoading: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({
  toast: { loading: toastLoading, success: toastSuccess, error: toastError },
  arcScanTxUrl: () => undefined,
}));
// The hook now imports only TX_RECEIPT_TIMEOUT_MS from useTxToast (it no longer uses useTxToast /
// useTxReceipt — those reactive hooks unmount with the banner before the receipt resolves).
vi.mock('@/hooks/useTxToast', () => ({ TX_RECEIPT_TIMEOUT_MS: 120_000 }));

const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
const writeContractAsync = vi.fn(async (_cfg: Record<string, unknown>) => '0xhash');
// The IMPERATIVE receipt wait (replaces the reactive useTxReceipt/useTxToast). Defaults to a success
// receipt; individual tests override it to assert the reverted / timeout branches.
const waitForTransactionReceipt = vi.fn(
  async (_cfg: { hash: string; timeout?: number }): Promise<{ status: 'success' | 'reverted' }> => ({ status: 'success' }),
);

// owedUSDC = 2 USDC, owedWETH = 0 -> hasCredit true. Keyed by functionName.
const useReadContract = vi.fn((cfg: { functionName?: string }) => {
  if (cfg.functionName === 'owedUSDC') return { data: 2_000_000n };
  if (cfg.functionName === 'owedWETH') return { data: 0n };
  return { data: undefined };
});
vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: USER }),
  usePublicClient: () => ({ simulateContract, waitForTransactionReceipt }),
  useReadContract: (cfg: { functionName?: string }) => useReadContract(cfg),
  useWriteContract: () => ({ writeContractAsync, data: undefined, isPending: false }),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ refetchQueries: vi.fn() }) }));

import { useWithdrawCredited } from '@/hooks/useWithdrawCredited';

beforeEach(() => {
  simulateContract.mockClear();
  writeContractAsync.mockClear();
  waitForTransactionReceipt.mockClear();
  toastLoading.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  waitForTransactionReceipt.mockResolvedValue({ status: 'success' as const });
});
afterEach(cleanup);

describe('useWithdrawCredited', () => {
  it('exposes the connected wallet owed* balances and hasCredit', () => {
    const { result } = renderHook(() => useWithdrawCredited());
    expect(result.current.owedUSDC).toBe(2_000_000n);
    expect(result.current.owedWETH).toBe(0n);
    expect(result.current.hasCredit).toBe(true);
  });

  it('simulates withdrawCredited(to) defaulting to the connected wallet, then writes with the gas floor', async () => {
    const { result } = renderHook(() => useWithdrawCredited());
    await act(async () => {
      await result.current.withdraw();
    });
    const simCfg = simulateContract.mock.calls[0][0] as { functionName: string; args: unknown[]; address: string };
    expect(simCfg.functionName).toBe('withdrawCredited');
    expect(simCfg.address).toBe(FEE_ARENA);
    expect(simCfg.args).toEqual([USER]); // default destination = connected wallet

    const wcfg = writeContractAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(wcfg.maxFeePerGas).toBe(20_000_000_000n);
    expect(wcfg.__sim).toBe(true);
  });

  it('forwards an explicit clean destination override', async () => {
    const TO = '0x4444444444444444444444444444444444444444' as const;
    const { result } = renderHook(() => useWithdrawCredited());
    await act(async () => {
      await result.current.withdraw({ to: TO });
    });
    const simCfg = simulateContract.mock.calls[0][0] as { args: unknown[] };
    expect(simCfg.args).toEqual([TO]);
  });

  it('resolves the loading toast to success IMPERATIVELY on a success receipt (even though the banner unmounts)', async () => {
    // The core regression test for the unmount-orphan bug. The reactive useTxToast/useTxReceipt hooks
    // are GONE — the success toast must be fired by the in-flight async fn itself (which survives the
    // banner's unmount when owed* zeroes), keyed to the SAME id as the submit-time loading toast.
    const { result } = renderHook(() => useWithdrawCredited());
    await act(async () => {
      await result.current.withdraw();
    });

    // Submit-time loading toast keyed to the shared withdraw id.
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastLoading.mock.calls[0][0]).toBe('Withdrawing credited balance');
    expect(toastLoading.mock.calls[0][1]).toMatchObject({ id: 'withdraw-credited' });

    // The receipt was awaited imperatively with the shared timeout.
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt.mock.calls[0][0]).toMatchObject({ hash: '0xhash', timeout: 120_000 });

    // On success the SAME keyed toast is resolved to success (in place), and isSuccess flips true.
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith('Withdrew credited balance', { id: 'withdraw-credited' });
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.isSuccess).toBe(true);
  });

  it('fires an error toast (not success) on a mined-but-REVERTED receipt', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' as const });
    const { result } = renderHook(() => useWithdrawCredited());
    await act(async () => {
      await result.current.withdraw();
    });
    // The write still went out (loading toast fired), but the receipt reverted — surface an error, not success.
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Withdraw reverted', { id: 'withdraw-credited' });
    expect(result.current.isSuccess).toBe(false);
  });

  it('replaces the spinner with a non-stuck toast when the receipt wait TIMES OUT (does not hang forever)', async () => {
    // The whole point of the fix: a rejecting/timeout receipt must STILL settle the keyed loading toast
    // (never leave an infinite sonner spinner). We reject the imperative wait and assert the reassuring
    // "couldn’t confirm yet" error toast fires on the SAME id — replacing the loading toast in place.
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'));
    const { result } = renderHook(() => useWithdrawCredited());
    await act(async () => {
      await result.current.withdraw();
    });
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toMatch(/couldn’t confirm yet/i);
    expect(toastError.mock.calls[0][1]).toMatchObject({ id: 'withdraw-credited' });
    // It did NOT throw (the withdraw tx was sent — the resolve returns the hash) and is not "successful".
    expect(result.current.isSuccess).toBe(false);
  });
});
