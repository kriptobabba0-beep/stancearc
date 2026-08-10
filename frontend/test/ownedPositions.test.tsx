import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

// useOwnedPositions must NOT classify positions until the active pool's base leg resolves — otherwise
// a non-ETH market would transiently filter against the wrong (default ETH) pair (Fix E). While
// useActiveBaseToken reports loading (address undefined), the hook must report isLoading:true and
// data:undefined, regardless of the NPM reads having resolved.

vi.mock('@/lib/env', () => ({
  ENV: {
    USDC_ADDRESS: '0x0000000000000000000000000000000000000002',
    FEE_TIER: 3000,
    WETH_ADDRESS: '0xeeee000000000000000000000000000000000000',
  },
}));

vi.mock('@/lib/contracts', () => ({
  npm: { address: '0x0000000000000000000000000000000000000001', abi: [] },
}));

// The base-token resolver — reconfigured per test via this holder.
const baseTokenMock = vi.fn();
vi.mock('@/hooks/useActiveBaseToken', () => ({ useActiveBaseToken: () => baseTokenMock() }));

vi.mock('@/hooks/useUserStakes', () => ({ useUserStakes: () => ({ data: [] }) }));
vi.mock('@/hooks/usePollInterval', () => ({ usePollInterval: () => 5000 }));

// Account connected; NPM reads RESOLVED (balance=0) so the only thing gating loading is the base leg.
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', isConnected: true }),
  useReadContract: () => ({ data: 0n, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: undefined, isLoading: false, isError: false }),
}));

import { useOwnedPositions } from '@/hooks/useOwnedPositions';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('useOwnedPositions (Fix E: gate on active base leg)', () => {
  it('stays loading (no data) while the active pool base leg is unresolved', () => {
    baseTokenMock.mockReturnValue({ address: undefined, decimals: 8, symbol: 'WBTC', baseIsToken0: undefined, isLoading: true });
    const { result } = renderHook(() => useOwnedPositions());
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  it('resolves to an empty list (not loading) once the base leg is known and the wallet owns none', () => {
    baseTokenMock.mockReturnValue({
      address: '0xbbbb000000000000000000000000000000000000',
      decimals: 8,
      symbol: 'WBTC',
      baseIsToken0: false,
      isLoading: false,
    });
    const { result } = renderHook(() => useOwnedPositions());
    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});
