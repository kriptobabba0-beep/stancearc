import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// useUnstake calls FeeArena.unstake(tokenId). We verify (a) it simulates unstake with the correct
// args, (b) it writes the simulated request WITH the Arc 20-gwei gas floor + 1-gwei priority fee
// — the regression guard for the under-pricing bug — and (c) it waits on the receipt IMPERATIVELY
// (publicClient.waitForTransactionReceipt) inside the async fn, NOT via the reactive useTxToast /
// useTxReceipt hooks. That's the fix for the unmount-orphan bug: unstaking an already-claimed position
// drops the row from ClaimUnstakePanel's filter, so the row UNMOUNTS before the receipt resolves — a
// reactive receipt-toast would never fire and the sonner loading spinner would hang forever. An
// in-flight async fn keeps running post-unmount, so the toast always settles to success/reverted/timeout.

const FEE_ARENA = '0x00000000000000000000000000000000feearena' as const;

vi.mock('@/lib/contracts', () => ({
  useMarketContracts: () => ({
    feeArena: { address: '0x00000000000000000000000000000000feearena' as const, abi: [] },
  }),
}));

vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
  MAX_PRIORITY_FEE_WEI: 1_000_000_000n,
  withGasFloor: <T,>(request: T) => ({
    ...request,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }),
}));

vi.mock('@/hooks/usePollInterval', () => ({ bumpPollAfterWrite: vi.fn() }));
vi.mock('@/lib/errors', () => ({ friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));

const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
let writeStartedAfterSimulate = false;
let simulateResolved = false;
const writeContractAsync = vi.fn(async (_cfg: Record<string, unknown>) => {
  writeStartedAfterSimulate = simulateResolved;
  return '0xhash';
});
// The IMPERATIVE receipt wait (replaces the reactive useTxReceipt/useTxToast). Defaults to a success
// receipt; individual tests override it to assert the reverted / timeout branches.
const waitForTransactionReceipt = vi.fn(
  async (_cfg: { hash: string; timeout?: number }): Promise<{ status: 'success' | 'reverted' }> => ({ status: 'success' }),
);
vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  usePublicClient: () => ({ simulateContract, waitForTransactionReceipt }),
  useWriteContract: () => ({ writeContractAsync, data: undefined, isPending: false }),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), refetchQueries: vi.fn() }) }));
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
// useTxReceipt — those reactive hooks unmount with the row before the receipt resolves).
vi.mock('@/hooks/useTxToast', () => ({ TX_RECEIPT_TIMEOUT_MS: 120_000 }));

import { useUnstake } from '@/hooks/useUnstake';

const USER = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  simulateContract.mockClear();
  writeContractAsync.mockClear();
  waitForTransactionReceipt.mockClear();
  toastLoading.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  waitForTransactionReceipt.mockResolvedValue({ status: 'success' as const });
  writeStartedAfterSimulate = false;
  simulateResolved = false;
  simulateContract.mockImplementation(async (cfg: unknown) => {
    simulateResolved = true;
    return { request: { ...(cfg as object), __sim: true } };
  });
});
afterEach(cleanup);

describe('useUnstake().unstake', () => {
  it('simulates unstake(tokenId) then writes with the gas floor', async () => {
    const { result } = renderHook(() => useUnstake());
    await act(async () => {
      await result.current.unstake({ tokenId: 99n });
    });

    expect(simulateContract).toHaveBeenCalledTimes(1);
    const simCfg = simulateContract.mock.calls[0][0] as {
      functionName: string;
      args: unknown[];
      account: string;
      address: string;
    };
    expect(simCfg.functionName).toBe('unstake');
    expect(simCfg.account).toBe(USER);
    expect(simCfg.address).toBe(FEE_ARENA);
    expect(simCfg.args).toEqual([99n]);

    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    const wcfg = writeContractAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(wcfg.maxFeePerGas).toBe(20_000_000_000n); // 20-gwei Arc floor
    expect(wcfg.maxPriorityFeePerGas).toBe(1_000_000_000n); // 1-gwei priority
    expect(wcfg.__sim).toBe(true); // simulated request forwarded to the write
  });

  it('simulates before it writes (simulate-then-write order holds)', async () => {
    const { result } = renderHook(() => useUnstake());
    await act(async () => {
      await result.current.unstake({ tokenId: 5n });
    });
    expect(writeStartedAfterSimulate).toBe(true);
  });

  it('resolves the loading toast to success IMPERATIVELY on a success receipt (even though the row unmounts)', async () => {
    // The core regression test for the unmount-orphan bug. The reactive useTxToast/useTxReceipt hooks
    // are GONE — the success toast must be fired by the in-flight async fn itself (which survives the
    // row's unmount), keyed to the SAME id as the submit-time loading toast so it replaces it in place.
    const { result } = renderHook(() => useUnstake());
    await act(async () => {
      await result.current.unstake({ tokenId: 99n });
    });

    // Submit-time loading toast keyed to the shared unstake id.
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastLoading.mock.calls[0][0]).toBe('Unstaking');
    expect(toastLoading.mock.calls[0][1]).toMatchObject({ id: 'unstake' });

    // The receipt was awaited imperatively with the shared timeout.
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt.mock.calls[0][0]).toMatchObject({ hash: '0xhash', timeout: 120_000 });

    // On success the SAME keyed toast is resolved to success (in place), and isSuccess flips true.
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith('Unstaked', { id: 'unstake' });
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.isSuccess).toBe(true);
  });

  it('fires an error toast (not success) on a mined-but-REVERTED receipt', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' as const });
    const { result } = renderHook(() => useUnstake());
    await act(async () => {
      await result.current.unstake({ tokenId: 99n });
    });
    // The write still went out (loading toast fired), but the receipt reverted — surface an error, not success.
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Unstake reverted', { id: 'unstake' });
    expect(result.current.isSuccess).toBe(false);
  });

  it('replaces the spinner with a non-stuck toast when the receipt wait TIMES OUT (does not hang forever)', async () => {
    // The whole point of the fix: a rejecting/timeout receipt must STILL settle the keyed loading toast
    // (never leave an infinite sonner spinner). We reject the imperative wait and assert the reassuring
    // "couldn’t confirm yet" error toast fires on the SAME id — replacing the loading toast in place.
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'));
    const { result } = renderHook(() => useUnstake());
    await act(async () => {
      await result.current.unstake({ tokenId: 99n });
    });
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toMatch(/couldn’t confirm yet/i);
    expect(toastError.mock.calls[0][1]).toMatchObject({ id: 'unstake' });
    // It did NOT throw (the unstake tx was sent — the resolve returns the hash) and is not "successful".
    expect(result.current.isSuccess).toBe(false);
  });
});
