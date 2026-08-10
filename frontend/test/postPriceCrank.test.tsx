import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

// --- module mocks (declared before importing the hook under test) ---

// Hermes update fetch — resolve a single 0x-prefixed update blob by default.
const fetchPythUpdate = vi.fn(async () => ({ updateData: ['0xabcd'] as `0x${string}`[] }));
vi.mock('@/lib/pyth', () => ({ fetchPythUpdate: () => fetchPythUpdate() }));

// ENV is a throwing Proxy in tests — stub the keys the hook + contracts read.
vi.mock('@/lib/env', () => ({
  ENV: {
    HERMES_URL: 'https://hermes.pyth.network',
    PYTH_ETHUSD_ID: '0xfeed',
    FEE_ARENA_ADDRESS: '0x00000000000000000000000000000000000000fa',
    PYTH_ADDRESS: '0x00000000000000000000000000000000000000ff',
  },
}));

// contracts.ts touches ENV at module load — stub the handles the hook uses.
vi.mock('@/lib/contracts', () => {
  const feeArena = { address: '0x00000000000000000000000000000000000000fa' as const, abi: [] };
  return {
    feeArena,
    // Active-market FeeArena/oracle/pool resolve through this hook now (multi-market).
    useMarketContracts: () => ({
      feeArena,
      oracle: { address: '0x00000000000000000000000000000000000000ab', abi: [] },
      pool: { address: '0x00000000000000000000000000000000000000ac', abi: [] },
    }),
    pythContract: { address: '0x00000000000000000000000000000000000000ff', abi: [] },
    swapRouter: { address: '0x0000000000000000000000000000000000000001', abi: [] },
    usdc: { address: '0x0000000000000000000000000000000000000002', abi: [] },
    weth: { address: '0x0000000000000000000000000000000000000003', abi: [] },
  };
});

// useAdminCranks reads the active market's feedId via useActiveMarket().
vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => ({
    id: 'eth',
    label: 'ETH / USDC',
    baseSymbol: 'WETH',
    baseDecimals: 18,
    feeArena: '0x00000000000000000000000000000000000000fa',
    oracle: '0x00000000000000000000000000000000000000ab',
    pool: '0x00000000000000000000000000000000000000ac',
    feedId: '0xfeed',
  }),
}));

// wagmi.ts builds a real config from ENV at module load — stub it out.
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));

// Public client `getUpdateFee` read returns a known fee.
const readContract = vi.fn(async () => 7n);
vi.mock('wagmi/actions', () => ({
  getPublicClient: () => ({ readContract }),
}));

// writeContract spy + receipt/query stubs.
const writeContract = vi.fn();
vi.mock('wagmi', () => ({
  useWriteContract: () => ({ writeContract, data: undefined, isPending: false, error: undefined, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
  useReadContract: () => ({ data: undefined }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { useAdminCranks } from '@/hooks/useAdminCranks';

beforeEach(() => {
  fetchPythUpdate.mockReset();
  fetchPythUpdate.mockResolvedValue({ updateData: ['0xabcd'] as `0x${string}`[] });
  readContract.mockReset();
  readContract.mockResolvedValue(7n);
  writeContract.mockReset();
});

afterEach(cleanup);

describe('usePostPriceCrank (via useAdminCranks().startEpoch)', () => {
  it('posts the Hermes update + pays the getUpdateFee value to startEpoch', async () => {
    const { result } = renderHook(() => useAdminCranks());

    await act(async () => {
      result.current.startEpoch.run();
    });

    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(1));

    const [config] = writeContract.mock.calls[0];
    expect(config.functionName).toBe('startEpoch');
    expect(config.args).toEqual([['0xabcd']]);
    expect(config.value).toBe(7n);
  });

  it('surfaces the prep error and does NOT writeContract when the Hermes fetch rejects', async () => {
    fetchPythUpdate.mockRejectedValueOnce(new Error('Hermes request failed (502)'));
    const { result } = renderHook(() => useAdminCranks());

    await act(async () => {
      result.current.startEpoch.run();
    });

    await waitFor(() => expect(result.current.startEpoch.error).toBeDefined());
    expect(result.current.startEpoch.error?.message).toContain('Hermes request failed');
    expect(writeContract).not.toHaveBeenCalled();
  });
});
