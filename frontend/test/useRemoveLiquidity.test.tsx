import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { decodeFunctionData } from 'viem';
import { nonfungiblePositionManagerAbi } from '@/abis/nonfungiblePositionManager';

// useRemoveLiquidity pulls 100% of a position's liquidity back to the owner. It reads the position's
// current liquidity via NPM.positions(tokenId), then withdraws via NPM.multicall([
//   decreaseLiquidity(tokenId, FULL liquidity, 0, 0, deadline),
//   collect(tokenId, owner, uint128.max, uint128.max),
// ]) in ONE tx, then waits on the receipt IMPERATIVELY (publicClient.waitForTransactionReceipt) inside
// the async fn — NOT via the reactive useTxToast/useTxReceipt hooks. That's the fix for the LIVE bug:
// a 100% withdraw makes the row UNMOUNT (the position vanishes from useOwnedPositions) before the
// receipt resolves, so a reactive receipt-toast would never fire and the sonner loading spinner would
// hang forever. An in-flight async fn keeps running post-unmount, so the toast always settles.
//
// We verify: (a) the simulated call is `multicall` on the NPM with TWO encoded inner calls
// (decreaseLiquidity FULL + collect to owner with max amounts), written WITH the Arc gas floor; (b) a
// success receipt fires toast.success('Liquidity + fees sent to your wallet', { id: 'remove-liquidity-42' }) — the
// per-tokenId id, imperatively — proving the toast RESOLVES with the reactive hook gone; (c) a
// reverted receipt fires toast.error; (d) waitForTransactionReceipt REJECTING (timeout) fires the
// non-stuck "couldn’t confirm yet" toast.error rather than an infinite spinner; (e) a 0-liquidity
// position is rejected client-side (no write); (f) the POSITIONAL positions() decode (liquidity at [7]).

const NPM_ADDR = '0x0000000000000000000000000000000000000abc' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;
const MAX_UINT128 = (1n << 128n) - 1n;

vi.mock('@/lib/contracts', () => ({
  npm: { address: '0x0000000000000000000000000000000000000abc' as const, abi: nonfungiblePositionManagerAbi },
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

// The position's current liquidity is read via NPM.positions(tokenId) — reconfigured per test.
const POSITION = {
  nonce: 0n, operator: '0x0000000000000000000000000000000000000000',
  token0: '0xaaaa000000000000000000000000000000000000',
  token1: '0xbbbb000000000000000000000000000000000000',
  fee: 3000, tickLower: -887220, tickUpper: 887220,
  liquidity: 123_456_789n,
  feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n, tokensOwed1: 0n,
};
const readContract = vi.fn(async (_cfg: { functionName: string; args: unknown[]; address: string }) => POSITION);

const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
const writeContractAsync = vi.fn(async (_cfg: Record<string, unknown>) => '0xhash');
// The IMPERATIVE receipt wait (replaces the reactive useTxReceipt/useTxToast). Defaults to a success
// receipt; individual tests override it to assert the reverted / timeout branches.
const waitForTransactionReceipt = vi.fn(
  async (_cfg: { hash: string; timeout?: number }): Promise<{ status: 'success' | 'reverted' }> => ({ status: 'success' }),
);

vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: USER }),
  usePublicClient: () => ({ simulateContract, readContract, waitForTransactionReceipt }),
  useWriteContract: () => ({ writeContractAsync, data: undefined, isPending: false }),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), refetchQueries: vi.fn() }) }));
// Spies shared into the hoisted vi.mock factory must be created via vi.hoisted (the factory runs before
// top-level const initialization). We record the toast loading/success/error calls so we can assert the
// toast is RESOLVED imperatively (per-tokenId id), proving it no longer relies on the unmount-fragile
// reactive useTxToast hook.
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

import { useRemoveLiquidity } from '@/hooks/useRemoveLiquidity';

beforeEach(() => {
  readContract.mockClear();
  simulateContract.mockClear();
  writeContractAsync.mockClear();
  waitForTransactionReceipt.mockClear();
  toastLoading.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  readContract.mockResolvedValue(POSITION);
  waitForTransactionReceipt.mockResolvedValue({ status: 'success' as const });
});
afterEach(cleanup);

describe('useRemoveLiquidity().remove', () => {
  it('reads current liquidity, then multicalls decreaseLiquidity(FULL) + collect(owner) in one tx', async () => {
    const { result } = renderHook(() => useRemoveLiquidity());
    await act(async () => {
      await result.current.remove({ tokenId: 42n });
    });

    // It first reads the position to learn the current liquidity.
    expect(readContract).toHaveBeenCalledTimes(1);
    const readCfg = readContract.mock.calls[0][0] as { functionName: string; args: unknown[]; address: string };
    expect(readCfg.functionName).toBe('positions');
    expect(readCfg.args).toEqual([42n]);
    expect(readCfg.address).toBe(NPM_ADDR);

    // One simulate of `multicall` on the NPM.
    expect(simulateContract).toHaveBeenCalledTimes(1);
    const simCfg = simulateContract.mock.calls[0][0] as {
      functionName: string; args: unknown[]; account: string; address: string;
    };
    expect(simCfg.functionName).toBe('multicall');
    expect(simCfg.account).toBe(USER);
    expect(simCfg.address).toBe(NPM_ADDR);

    // multicall(bytes[]) — two encoded inner calls.
    const innerCalls = simCfg.args[0] as readonly `0x${string}`[];
    expect(Array.isArray(innerCalls)).toBe(true);
    expect(innerCalls).toHaveLength(2);

    // Inner #1: decreaseLiquidity(tokenId, FULL liquidity, amount0Min=0, amount1Min=0, deadline).
    const dec = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: innerCalls[0] });
    expect(dec.functionName).toBe('decreaseLiquidity');
    const decParams = (dec.args as readonly unknown[])[0] as {
      tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint;
    };
    expect(decParams.tokenId).toBe(42n);
    expect(decParams.liquidity).toBe(POSITION.liquidity); // FULL current liquidity
    expect(decParams.amount0Min).toBe(0n);
    expect(decParams.amount1Min).toBe(0n);
    expect(decParams.deadline).toBeGreaterThan(0n);

    // Inner #2: collect(tokenId, recipient=owner, amount0Max=uint128.max, amount1Max=uint128.max).
    const col = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: innerCalls[1] });
    expect(col.functionName).toBe('collect');
    const colParams = (col.args as readonly unknown[])[0] as {
      tokenId: bigint; recipient: string; amount0Max: bigint; amount1Max: bigint;
    };
    expect(colParams.tokenId).toBe(42n);
    expect(colParams.recipient).toBe(USER);
    expect(colParams.amount0Max).toBe(MAX_UINT128);
    expect(colParams.amount1Max).toBe(MAX_UINT128);

    // The simulated request is written WITH the Arc 20-gwei gas floor + 1-gwei priority fee.
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    const wcfg = writeContractAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(wcfg.maxFeePerGas).toBe(20_000_000_000n);
    expect(wcfg.maxPriorityFeePerGas).toBe(1_000_000_000n);
    expect(wcfg.__sim).toBe(true);
  });

  it('resolves the loading toast to success IMPERATIVELY on a success receipt (per-tokenId id, even though the row unmounts)', async () => {
    // This is the core regression test for the LIVE bug. The reactive useTxToast/useTxReceipt hooks are
    // GONE — the success toast must be fired by the in-flight async fn itself (which survives unmount),
    // keyed to the SAME per-tokenId id as the submit-time loading toast so it replaces it in place.
    const { result } = renderHook(() => useRemoveLiquidity());
    await act(async () => {
      await result.current.remove({ tokenId: 42n });
    });

    // Submit-time loading toast keyed to this row's tokenId.
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastLoading.mock.calls[0][0]).toBe('Withdrawing liquidity + fees');
    expect(toastLoading.mock.calls[0][1]).toMatchObject({ id: 'remove-liquidity-42' });

    // The receipt was awaited imperatively with the shared timeout.
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt.mock.calls[0][0]).toMatchObject({ hash: '0xhash', timeout: 120_000 });

    // On success the SAME keyed toast is resolved to success (in place), and isSuccess flips true.
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith('Liquidity + fees sent to your wallet', { id: 'remove-liquidity-42' });
    expect(toastError).not.toHaveBeenCalled();
    expect(result.current.isSuccess).toBe(true);
  });

  it('fires an error toast (not success) on a mined-but-REVERTED receipt', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' as const });
    const { result } = renderHook(() => useRemoveLiquidity());
    await act(async () => {
      await result.current.remove({ tokenId: 42n });
    });
    // The write still went out (loading toast fired), but the receipt reverted — surface an error, not success.
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Remove liquidity reverted', { id: 'remove-liquidity-42' });
    expect(result.current.isSuccess).toBe(false);
  });

  it('replaces the spinner with a non-stuck toast when the receipt wait TIMES OUT (does not hang forever)', async () => {
    // The whole point of the fix: a rejecting/timeout receipt must STILL settle the keyed loading toast
    // (never leave an infinite sonner spinner). We reject the imperative wait and assert the reassuring
    // "couldn’t confirm yet" error toast fires on the SAME id — replacing the loading toast in place.
    waitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'));
    const { result } = renderHook(() => useRemoveLiquidity());
    await act(async () => {
      await result.current.remove({ tokenId: 42n });
    });
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toMatch(/couldn’t confirm yet/i);
    expect(toastError.mock.calls[0][1]).toMatchObject({ id: 'remove-liquidity-42' });
    // It did NOT throw (the withdraw tx was sent — the resolve returns the hash) and is not "successful".
    expect(result.current.isSuccess).toBe(false);
  });

  it('handles the POSITIONAL positions() decode (viem returns an array; liquidity at [7], not a named field)', async () => {
    // The real NPM.positions() decodes positionally — no `.liquidity` named field; liquidity is index [7].
    // A bare `position.liquidity` was undefined -> "Cannot convert undefined to a BigInt" on Withdraw.
    const positional = [
      0n, '0x0000000000000000000000000000000000000000',
      '0xaaaa000000000000000000000000000000000000', '0xbbbb000000000000000000000000000000000000',
      3000, -887220, 887220, 999_000_111n, 0n, 0n, 0n, 0n,
    ];
    readContract.mockResolvedValue(positional as unknown as typeof POSITION);
    const { result } = renderHook(() => useRemoveLiquidity());
    await act(async () => {
      await result.current.remove({ tokenId: 42n });
    });
    // Must NOT throw, and decreaseLiquidity must use the index-[7] liquidity.
    expect(simulateContract).toHaveBeenCalledTimes(1);
    const innerCalls = (simulateContract.mock.calls[0][0] as { args: unknown[] }).args[0] as readonly `0x${string}`[];
    const dec = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: innerCalls[0] });
    expect(dec.functionName).toBe('decreaseLiquidity');
    expect(((dec.args as readonly unknown[])[0] as { liquidity: bigint }).liquidity).toBe(999_000_111n);
  });

  it('rejects a 0-liquidity position (nothing to remove) without simulating or writing', async () => {
    readContract.mockResolvedValue({ ...POSITION, liquidity: 0n });
    const { result } = renderHook(() => useRemoveLiquidity());
    await act(async () => {
      await expect(result.current.remove({ tokenId: 7n })).rejects.toThrow();
    });
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContractAsync).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('keys the error toast to the tokenId when the simulation reverts', async () => {
    simulateContract.mockRejectedValueOnce(new Error('not owner'));
    const { result } = renderHook(() => useRemoveLiquidity());
    await act(async () => {
      await expect(result.current.remove({ tokenId: 7n })).rejects.toThrow();
    });
    // Pre-write failure: no loading toast, no receipt wait — just the keyed error toast.
    expect(toastLoading).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][1]).toMatchObject({ id: 'remove-liquidity-7' });
  });
});
