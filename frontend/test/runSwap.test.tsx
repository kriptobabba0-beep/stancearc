import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { parseUnits } from 'viem';

// Active market = BTC/USDC with an 8-dp WBTC base. The demo swap must swap the WBTC leg against the
// global USDC, NOT the global WETH (which is wrong on this market), and amounts parse at 8dp.
// NOTE: vi.mock factories are hoisted above imports, so addresses are inlined inside them. The same
// literals are re-declared (below the mocks) for the assertions.

vi.mock('@/lib/env', () => ({
  ENV: {
    FEE_ARENA_ADDRESS: '0x00000000000000000000000000000000000000fa',
    PYTH_ADDRESS: '0x00000000000000000000000000000000000000ff',
    HERMES_URL: 'https://hermes.pyth.network',
    FEE_TIER: 3000,
  },
}));

vi.mock('@/lib/contracts', () => {
  const feeArena = { address: '0x00000000000000000000000000000000000000fa' as const, abi: [] };
  return {
    feeArena,
    useMarketContracts: () => ({
      feeArena,
      oracle: { address: '0x00000000000000000000000000000000000000ab', abi: [] },
      pool: { address: '0x00000000000000000000000000000000000000ac', abi: [] },
    }),
    pythContract: { address: '0x00000000000000000000000000000000000000ff', abi: [] },
    swapRouter: { address: '0x0000000000000000000000000000000000000001', abi: [] },
    usdc: { address: '0x0000000000000000000000000000000000000002', abi: [] },
  };
});

// Re-declared for assertions (kept in sync with the inlined literals above).
const WBTC = '0xbbbb000000000000000000000000000000000000';
const USDC = '0x0000000000000000000000000000000000000002';

vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => ({
    id: 'btc',
    label: 'BTC / USDC',
    baseSymbol: 'WBTC',
    baseDecimals: 8,
    feeArena: '0x00000000000000000000000000000000000000fa',
    oracle: '0x00000000000000000000000000000000000000ab',
    pool: '0x00000000000000000000000000000000000000ac',
    feedId: '0xfeed',
  }),
}));

vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('wagmi/actions', () => ({ getPublicClient: () => ({ readContract: vi.fn() }) }));

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
  writeContract.mockReset();
});
afterEach(cleanup);

describe('useAdminCranks().runSwap (active-market base)', () => {
  it('BASE_TO_USDC swaps the active WBTC leg in, USDC out, at the active fee tier and 8dp amount', () => {
    const { result } = renderHook(() => useAdminCranks());

    // "0.5" WBTC parsed at the active market's 8 decimals (NOT 18).
    const amountIn = parseUnits('0.5', 8);
    expect(amountIn).toBe(50_000_000n);

    act(() => {
      result.current.runSwap.run({
        direction: 'BASE_TO_USDC',
        baseToken: WBTC,
        feeTier: 3000,
        recipient: '0x1111111111111111111111111111111111111111',
        amountIn,
      });
    });

    expect(writeContract).toHaveBeenCalledTimes(1);
    const [config] = writeContract.mock.calls[0];
    expect(config.functionName).toBe('exactInputSingle');
    const params = config.args[0];
    expect(params.tokenIn).toBe(WBTC); // the active base, NOT the global WETH
    expect(params.tokenOut).toBe(USDC);
    expect(params.fee).toBe(3000);
    expect(params.amountIn).toBe(50_000_000n); // 0.5 at 8dp
  });

  it('USDC_TO_BASE swaps USDC in, the active WBTC leg out', () => {
    const { result } = renderHook(() => useAdminCranks());

    act(() => {
      result.current.runSwap.run({
        direction: 'USDC_TO_BASE',
        baseToken: WBTC,
        feeTier: 3000,
        recipient: '0x1111111111111111111111111111111111111111',
        amountIn: 1_000000n,
      });
    });

    const [config] = writeContract.mock.calls[0];
    const params = config.args[0];
    expect(params.tokenIn).toBe(USDC);
    expect(params.tokenOut).toBe(WBTC);
  });
});
