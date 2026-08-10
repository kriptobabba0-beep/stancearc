import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// useStakeWithSide does an atomic stake via NPM.safeTransferFrom(user, feeArena, tokenId, encodedSide).
// We verify (a) it simulates safeTransferFrom with the correct args (encoded side as the data word),
// and (b) it writes the simulated request WITH the Arc 20-gwei gas floor (maxFeePerGas) and 1-gwei
// priority fee — the regression guard for the under-pricing bug. Mocking mirrors useMintPosition.test.tsx.

const NPM = '0x00000000000000000000000000000000000000aa' as const;
const FEE_ARENA = '0x00000000000000000000000000000000feearena' as const;

vi.mock('@/lib/contracts', () => ({
  // NOTE: vi.mock factories are hoisted above imports — addresses MUST be inlined here.
  npm: { address: '0x00000000000000000000000000000000000000aa' as const, abi: [] },
  pythContract: { address: '0x00000000000000000000000000000000000000bb' as const, abi: [] },
  useMarketContracts: () => ({
    feeArena: { address: '0x00000000000000000000000000000000feearena' as const, abi: [] },
  }),
}));

// useStakeWithSide is version-aware: it reads the active market + isV3Market to choose the v1
// (push: safeTransferFrom) vs v3 (anchored: approve + payable stakeWithSide) path. These tests drive
// the v1 path, so isV3Market must resolve false. The v3-specific path is covered separately below.
const IS_V3 = vi.hoisted(() => ({ current: false }));
vi.mock('@/lib/markets', () => ({ isV3Market: () => IS_V3.current }));
vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => ({ feedId: '0xfeed000000000000000000000000000000000000000000000000000000000000' }),
}));
vi.mock('@/lib/env', () => ({ ENV: { HERMES_URL: 'https://hermes.example' } }));
vi.mock('@/lib/pyth', () => ({
  fetchPythUpdateWithPrice: vi.fn(async () => ({ updateData: ['0xblob'], price18: 63_000_000000000000000000n, publishTimeSec: 1 })),
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

// publicClient.simulateContract returns a { request } echoing the call; writeContractAsync spies.
const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
let writeStartedAfterSimulate = false;
let simulateResolved = false;
const writeContractAsync = vi.fn(async (_cfg: Record<string, unknown>) => {
  writeStartedAfterSimulate = simulateResolved;
  return '0xhash';
});
// Reconfigurable receipt-query + submitted hash so a test can drive the success / reverted / error
// branches of the centralized tx-lifecycle (useTxToast). Captured args assert the timeout.
const receiptQuery = vi.hoisted(() => ({
  current: { isLoading: false, isSuccess: false, isError: false, data: undefined } as Record<string, unknown>,
}));
const waitForReceiptArgs = vi.hoisted(() => ({ current: undefined as unknown }));
const writeHash = vi.hoisted(() => ({ current: undefined as `0x${string}` | undefined }));
// v3 path reads getUpdateFee + isApprovedForAll off the publicClient and awaits receipts directly.
const readContract = vi.hoisted(() => vi.fn(async (cfg: { functionName: string }): Promise<unknown> => {
  if (cfg.functionName === 'getUpdateFee') return 7n;
  if (cfg.functionName === 'isApprovedForAll') return true; // already an operator -> no extra approve tx
  return undefined;
}));
const waitForTransactionReceipt = vi.hoisted(() => vi.fn(async () => ({ status: 'success' })));
vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  usePublicClient: () => ({ simulateContract, readContract, waitForTransactionReceipt }),
  useWriteContract: () => ({ writeContractAsync, data: writeHash.current, isPending: false }),
  useWaitForTransactionReceipt: (args: unknown) => {
    waitForReceiptArgs.current = args;
    return receiptQuery.current;
  },
}));

// Shared refetchQueries spy so we can assert the live-refetch (Bug 1a) — the hook must force an
// immediate refetch of all mounted queries on success, not just invalidate.
const refetchQueries = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), refetchQueries }) }));
// Capture toast lifecycle calls so we can assert success vs. reverted/error (Fix 2/3).
const toastMock = vi.hoisted(() => ({ loading: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock, arcScanTxUrl: () => undefined }));

import { useStakeWithSide } from '@/hooks/useStakeWithSide';
import { encodeSide } from '@/lib/side';
import { Side } from '@/lib/types';

const USER = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  IS_V3.current = false;
  readContract.mockClear();
  waitForTransactionReceipt.mockClear();
  simulateContract.mockClear();
  writeContractAsync.mockClear();
  refetchQueries.mockClear();
  toastMock.loading.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  receiptQuery.current = { isLoading: false, isSuccess: false, isError: false, data: undefined };
  waitForReceiptArgs.current = undefined;
  writeHash.current = undefined;
  writeStartedAfterSimulate = false;
  simulateResolved = false;
  simulateContract.mockImplementation(async (cfg: unknown) => {
    simulateResolved = true;
    return { request: { ...(cfg as object), __sim: true } };
  });
});
afterEach(cleanup);

describe('useStakeWithSide().stake', () => {
  it('simulates safeTransferFrom(user, feeArena, tokenId, encodedSide) then writes with the gas floor', async () => {
    const { result } = renderHook(() => useStakeWithSide());
    await act(async () => {
      await result.current.stake({ tokenId: 42n, side: Side.UP });
    });

    expect(simulateContract).toHaveBeenCalledTimes(1);
    const simCfg = simulateContract.mock.calls[0][0] as {
      functionName: string;
      args: unknown[];
      account: string;
      address: string;
    };
    expect(simCfg.functionName).toBe('safeTransferFrom');
    expect(simCfg.account).toBe(USER);
    expect(simCfg.address).toBe(NPM);
    expect(simCfg.args).toEqual([USER, FEE_ARENA, 42n, encodeSide(Side.UP)]);

    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    const wcfg = writeContractAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(wcfg.maxFeePerGas).toBe(20_000_000_000n); // 20-gwei Arc floor
    expect(wcfg.maxPriorityFeePerGas).toBe(1_000_000_000n); // 1-gwei priority
    expect(wcfg.__sim).toBe(true); // simulated request forwarded to the write
  });

  it('simulates before it writes (simulate-then-write order holds)', async () => {
    const { result } = renderHook(() => useStakeWithSide());
    await act(async () => {
      await result.current.stake({ tokenId: 7n, side: Side.RANGE });
    });
    expect(writeStartedAfterSimulate).toBe(true);
  });

  it('Bug 1a: forces an immediate refetch of active queries after the write resolves', async () => {
    const { result } = renderHook(() => useStakeWithSide());
    await act(async () => {
      await result.current.stake({ tokenId: 42n, side: Side.UP });
    });
    expect(refetchQueries).toHaveBeenCalledWith({ type: 'active' });
  });
});

describe('useStakeWithSide v3 (entry-anchored) path', () => {
  it('uses isApprovedForAll/setApprovalForAll (NOT getApproved/approve) and a payable stakeWithSide', async () => {
    IS_V3.current = true;
    // Arena is NOT yet an operator -> the hook must send setApprovalForAll first.
    readContract.mockImplementation(async (cfg: { functionName: string }) => {
      if (cfg.functionName === 'getUpdateFee') return 9n;
      if (cfg.functionName === 'isApprovedForAll') return false;
      if (cfg.functionName === 'getApproved') throw new Error('getApproved must NOT be called on v3');
      return undefined;
    });

    const { result } = renderHook(() => useStakeWithSide());
    await act(async () => {
      await result.current.stake({ tokenId: 23n, side: Side.RANGE });
    });

    // It must NEVER read getApproved (the bug we fixed) — only isApprovedForAll.
    const reads = readContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    expect(reads).toContain('isApprovedForAll');
    expect(reads).not.toContain('getApproved');

    // Two simulated writes: setApprovalForAll(arena, true) then the payable stakeWithSide.
    const simFns = simulateContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    expect(simFns).toEqual(['setApprovalForAll', 'stakeWithSide']);

    const approveCfg = simulateContract.mock.calls[0][0] as { args: unknown[] };
    expect(approveCfg.args).toEqual([FEE_ARENA, true]);

    const stakeCfg = simulateContract.mock.calls[1][0] as { args: unknown[]; value: bigint };
    // stakeWithSide(tokenId, side, expectedEntryPrice18, maxDeviationBps, priceData) + Pyth fee as value
    expect(stakeCfg.args[0]).toBe(23n);
    expect(stakeCfg.args[1]).toBe(Side.RANGE);
    expect(stakeCfg.args[2]).toBe(63_000_000000000000000000n); // expected price from the Hermes blob
    expect(stakeCfg.args[3]).toBe(50n); // DEFAULT_MAX_DEVIATION_BPS (0.5%)
    expect(stakeCfg.value).toBe(9n); // Pyth update fee
  });

  it('skips the approve tx when the arena is already an operator', async () => {
    IS_V3.current = true;
    readContract.mockImplementation(async (cfg: { functionName: string }) => {
      if (cfg.functionName === 'getUpdateFee') return 9n;
      if (cfg.functionName === 'isApprovedForAll') return true;
      return undefined;
    });
    const { result } = renderHook(() => useStakeWithSide());
    await act(async () => {
      await result.current.stake({ tokenId: 23n, side: Side.UP });
    });
    const simFns = simulateContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    expect(simFns).toEqual(['stakeWithSide']); // no setApprovalForAll when already approved
  });
});

describe('useStakeWithSide tx-lifecycle (Fix 2/3 via useTxToast)', () => {
  it('creates the receipt query with a 120s timeout (Fix 3)', () => {
    renderHook(() => useStakeWithSide());
    expect((waitForReceiptArgs.current as { timeout?: number }).timeout).toBe(120_000);
  });

  it('Fix 2: a mined-but-REVERTED receipt fires an error toast, NOT success', () => {
    writeHash.current = '0xabc';
    receiptQuery.current = {
      isLoading: false,
      isSuccess: true, // viem resolves isSuccess=true even on a revert
      isError: false,
      data: { status: 'reverted' },
    };
    renderHook(() => useStakeWithSide());
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    // A revert must NOT claim success — no success-refetch path.
    expect(refetchQueries).not.toHaveBeenCalled();
  });

  it('Fix 2: a mined SUCCESS receipt fires the success toast + refetches', () => {
    writeHash.current = '0xabc';
    receiptQuery.current = {
      isLoading: false,
      isSuccess: true,
      isError: false,
      data: { status: 'success' },
    };
    renderHook(() => useStakeWithSide());
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(refetchQueries).toHaveBeenCalledWith({ type: 'active' });
  });

  it('Fix 3: a receipt query ERROR/timeout fires a "could not confirm" error toast', () => {
    writeHash.current = '0xabc';
    receiptQuery.current = { isLoading: false, isSuccess: false, isError: true, data: undefined };
    renderHook(() => useStakeWithSide());
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });
});
